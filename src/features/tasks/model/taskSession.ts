import {
  ADD_NOTE_TO_CHAT_EVENT,
  type NoteComposerCard,
} from "../../notes/notes";
import { linkLabel } from "./taskLinkText";
import { allTasks, type Task } from "./tasks";
import { peekTasks, updateTask } from "./tasksStore";
import { taskFilePath } from "./taskViewState";

/**
 * What a new session learns about the task: where the file is, a summary,
 * and the rules for the two things it may change in it.
 */
export function taskSessionContext(task: Task, root: string): string {
  const lines = [`File: ${taskFilePath(root, task)}`, `Column: ${task.column}`];
  if (task.status) lines.push(`Status: ${task.status}`);
  if (task.due) lines.push(`Due: ${task.due}`);
  if (task.priority) lines.push(`Priority: ${task.priority}`);
  if (task.tags.length) lines.push(`Tags: ${task.tags.join(", ")}`);
  if (task.links.length) {
    lines.push("", "Linked items:");
    for (const link of task.links)
      lines.push(`- ${linkLabel(link)} — ${link.url}`);
  }
  if (task.todos.length) {
    lines.push("", "Todos:");
    for (const todo of task.todos) {
      lines.push(`- [${todo.done ? "x" : " "}] ${todo.text}`);
    }
  }
  if (task.document.trim()) {
    lines.push(
      "",
      "The task file also has a document under `## Document`; read the file when you need it.",
    );
  }
  lines.push(
    "",
    "You may keep this task current as you work, editing only these parts of the file:",
    "- Check off a todo by changing `- [ ]` to `- [x]` on its line under `## Todos`, or add `- [ ] …` lines there.",
    "- Replace the one-line `status:` value in the YAML frontmatter with where the work stands.",
    "Leave every other line — the `id`, other frontmatter keys, and the document — as it is.",
  );
  return lines.join("\n");
}

/** The project a session for this task starts in, before the user picks one. */
export function defaultTaskProject(
  task: Task,
  fallback: string | undefined,
): string | undefined {
  return (
    task.project ??
    task.links.find((link) => link.projectPath)?.projectPath ??
    fallback
  );
}

/**
 * Opens a new session in `cwd` with the task as a chip above the composer.
 * The shell creates the session and calls `linkTaskSession` with its id.
 */
export function startTaskSession(task: Task, cwd: string): void {
  const root = peekTasks().root;
  if (!root) return;
  const card: NoteComposerCard = {
    id: task.id,
    slug: "",
    title: task.title,
    sourceCwd: cwd,
    kind: "task",
    taskPath: task.path,
    body: taskSessionContext(task, root),
  };
  window.dispatchEvent(
    new CustomEvent<NoteComposerCard>(ADD_NOTE_TO_CHAT_EVENT, { detail: card }),
  );
}

/** Records a session in its task's `sessions`, and the project it ran in. */
export async function linkTaskSession(
  card: Pick<NoteComposerCard, "id" | "taskPath" | "sourceCwd">,
  sessionId: string,
): Promise<void> {
  const tasks = allTasks(peekTasks().board);
  const task =
    tasks.find((entry) => entry.id === card.id) ??
    tasks.find((entry) => entry.path === card.taskPath);
  if (!task) return;
  const linked = await updateTask(task, { type: "addSession", sessionId });
  if (linked && card.sourceCwd && !linked.project) {
    await updateTask(linked, { type: "setProject", project: card.sourceCwd });
  }
}
