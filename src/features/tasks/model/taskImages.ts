import { invoke } from "@tauri-apps/api/core";
import {
  attachmentsFromFiles,
  attachmentsFromPaths,
  revokeAttachment,
} from "../../sessions/model/attachments";
import type { Attachment } from "../../sessions/model/session";
import type { NoteImageAsset } from "../../notes/noteImages";
import type { Task } from "./tasks";

type SavedImage = NoteImageAsset & { task: Task };

export type TaskImagesResult = { images: NoteImageAsset[]; task: Task };

export function saveTaskImagesFromFiles(
  root: string,
  task: Task,
  files: File[],
): Promise<TaskImagesResult> {
  return attachmentsFromFiles(files).then((files) => save(root, task, files));
}

export function saveTaskImagesFromPaths(
  root: string,
  task: Task,
  paths: string[],
): Promise<TaskImagesResult> {
  return attachmentsFromPaths(paths).then((files) => save(root, task, files));
}

/**
 * Copies images into the folder's `.assets/<task id>/`. The first image may
 * give the task its id, so later ones use the task it comes back as.
 */
async function save(
  root: string,
  task: Task,
  attachments: Attachment[],
): Promise<TaskImagesResult> {
  const images = attachments.filter((file) => file.kind === "image");
  if (images.length === 0) {
    throw new Error("Use a PNG, JPG, GIF, WebP, or SVG image.");
  }
  const saved: NoteImageAsset[] = [];
  let current = task;
  let failure: unknown;
  try {
    for (const image of images) {
      let sourcePath = image.path;
      let temporary = false;
      if (!sourcePath && image.data) {
        sourcePath = await invoke<string>("write_attachment", {
          name: image.name,
          data: image.data,
        });
        temporary = true;
      }
      if (!sourcePath) continue;
      try {
        const result = await invoke<SavedImage>("tasks_save_image", {
          root,
          id: current.id,
          path: current.path,
          sourcePath,
        });
        current = result.task;
        saved.push({ name: result.name, markdownPath: result.markdownPath });
      } catch (error) {
        failure ??= error;
      } finally {
        if (temporary) {
          await invoke("delete_path", { path: sourcePath }).catch(
            () => undefined,
          );
        }
      }
    }
  } finally {
    for (const image of images) revokeAttachment(image);
  }
  if (saved.length === 0) {
    throw failure instanceof Error
      ? failure
      : new Error(failure ? String(failure) : "No image could be added.");
  }
  return { images: saved, task: current };
}
