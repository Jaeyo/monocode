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

/** Absolute path of a task file. */
export function taskFilePath(root: string, task: Pick<Task, "path">): string {
  return `${root.replace(/\/+$/, "")}/${task.path}`;
}
