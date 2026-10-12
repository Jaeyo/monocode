import type { Task } from "./tasks";

const COLLAPSED_KEY = "monocode.tasksCollapsed";

type Collapsed = Record<string, boolean>;

function readCollapsed(): Collapsed {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Collapsed) : {};
  } catch {
    return {};
  }
}

function collapsedKey(root: string, column: string): string {
  return `${root}\n${column}`;
}

/** Collapsed columns, keyed per folder. The done column starts collapsed. */
export function isColumnCollapsed(
  root: string,
  column: string,
  doneColumn: string | null,
): boolean {
  return readCollapsed()[collapsedKey(root, column)] ?? column === doneColumn;
}

export function setColumnCollapsed(
  root: string,
  column: string,
  collapsed: boolean,
): void {
  try {
    const next = readCollapsed();
    next[collapsedKey(root, column)] = collapsed;
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  } catch {
    // Not remembering a fold is harmless.
  }
}

export const TASK_SELECT_EVENT = "monocode:task-select";
let pendingSelection: Pick<Task, "id" | "path"> | null = null;

/** Asks the Tasks view to show `task`, whether or not it is open yet. */
export function requestTaskSelection(task: Pick<Task, "id" | "path">): void {
  pendingSelection = { id: task.id, path: task.path };
  window.dispatchEvent(new CustomEvent(TASK_SELECT_EVENT));
}

export const TASK_FILTER_EVENT = "monocode:task-filter";
let pendingOverdue = false;

/** Asks the Tasks view to show only overdue tasks (a due reminder's click). */
export function requestOverdueFilter(): void {
  pendingOverdue = true;
  window.dispatchEvent(new CustomEvent(TASK_FILTER_EVENT));
}

export function takeOverdueFilter(): boolean {
  const pending = pendingOverdue;
  pendingOverdue = false;
  return pending;
}

/** The shell opens the Tasks view on this, from a session's task chip. */
export const OPEN_TASK_EVENT = "monocode:open-task";

export function openTaskFromChip(task: Pick<Task, "id" | "path">): void {
  window.dispatchEvent(
    new CustomEvent<Pick<Task, "id" | "path">>(OPEN_TASK_EVENT, {
      detail: { id: task.id, path: task.path },
    }),
  );
}

export function takeTaskSelection(): Pick<Task, "id" | "path"> | null {
  const selection = pendingSelection;
  pendingSelection = null;
  return selection;
}

/** Absolute path of a task file. */
export function taskFilePath(root: string, task: Pick<Task, "path">): string {
  return `${root.replace(/\/+$/, "")}/${task.path}`;
}
