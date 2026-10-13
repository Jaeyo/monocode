import { dismissToast, showToast } from "../../../shared/ui/Toasts";
import type { Task } from "./tasks";
import {
  deleteTask,
  flushDeletedTask,
  moveTask,
  peekTasks,
  restoreTask,
} from "./tasksStore";

type Undo = { run: () => Promise<void> };

// Only the latest move or delete can be undone, from its toast or with ⌘Z.
let lastUndo: Undo | null = null;

/** Takes the pending undo, if any, so it runs at most once. */
export function takeTaskUndo(): Undo | null {
  const undo = lastUndo;
  lastUndo = null;
  return undo;
}

function positionOf(task: Task): { column: string; index: number } | null {
  for (const column of peekTasks().board?.columns ?? []) {
    const index = column.tasks.findIndex((entry) => entry.id === task.id);
    if (index >= 0) return { column: column.name, index };
  }
  return null;
}

/**
 * Moves a task, offering an undo when it changed columns. `index` is the
 * position within `column` once the task is there.
 */
export async function moveTaskWithUndo(
  task: Task,
  column: string,
  index: number,
): Promise<void> {
  const from = positionOf(task);
  const board = await moveTask(task, column, index);
  if (!board || !from || from.column === column) return;
  const target = board.columns.find((entry) => entry.name === column);
  // A file without an id gets one on its first move, so find it by position.
  const moved = target?.tasks[Math.min(index, target.tasks.length - 1)];
  if (!moved) return;
  let toastId = 0;
  const undo: Undo = {
    run: async () => {
      if (lastUndo === undo) lastUndo = null;
      dismissToast(toastId);
      await moveTask(moved, from.column, from.index);
    },
  };
  lastUndo = undo;
  toastId = showToast(`Moved “${task.title}” to ${column}.`, {
    action: { label: "Undo", run: () => void undo.run() },
    onExpire: () => {
      if (lastUndo === undo) lastUndo = null;
    },
  });
}

/**
 * Deletes a task into the folder's `.trash`. The undo window is the toast's
 * lifetime; after it the file goes on to the system trash.
 */
export async function deleteTaskWithUndo(task: Task): Promise<void> {
  const token = await deleteTask(task);
  if (!token) return;
  let restored = false;
  let toastId = 0;
  const undo: Undo = {
    run: async () => {
      if (restored) return;
      restored = true;
      if (lastUndo === undo) lastUndo = null;
      dismissToast(toastId);
      await restoreTask(token);
    },
  };
  lastUndo = undo;
  toastId = showToast(`Deleted “${task.title}”.`, {
    action: { label: "Undo", run: () => void undo.run() },
    onExpire: () => {
      if (lastUndo === undo) lastUndo = null;
      if (!restored) flushDeletedTask(token);
    },
  });
}
