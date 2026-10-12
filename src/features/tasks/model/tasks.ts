import { invoke } from "@tauri-apps/api/core";

/** One Inbox item a task points at. Mirrors the fields `inboxIdentityKey` reads. */
export type TaskLink = {
  provider: string;
  repo: string;
  kind: string;
  number?: number;
  url: string;
  /** Snapshot taken when linked, shown when the provider is unavailable. */
  title: string;
  identifier?: string;
  id?: string;
  projectPath?: string;
};

export type TaskTodo = { text: string; done: boolean };

export type Task = {
  /** `~<path>` while the file has no id of its own yet. */
  id: string;
  persisted: boolean;
  /** Relative to the tasks root, `/`-separated. */
  path: string;
  column: string;
  fileName: string;
  title: string;
  status: string;
  due: string | null;
  priority: string | null;
  tags: string[];
  links: TaskLink[];
  sessions: string[];
  project: string | null;
  todos: TaskTodo[];
  document: string;
  readOnly: boolean;
  error: string | null;
  duplicate: boolean;
  modifiedAt: number;
};

export type TaskColumn = {
  name: string;
  configured: boolean;
  exists: boolean;
  tasks: Task[];
};

export type TaskBoard = {
  root: string;
  configured: boolean;
  columns: TaskColumn[];
  doneColumn: string | null;
  warnings: string[];
};

export type TaskEdit =
  | { type: "setTitle"; title: string }
  | { type: "setStatus"; status: string }
  | { type: "setDue"; due: string | null }
  | { type: "setPriority"; priority: string | null }
  | { type: "setTags"; tags: string[] }
  | { type: "setProject"; project: string | null }
  | { type: "addLink"; link: TaskLink }
  | { type: "removeLink"; url: string }
  | { type: "addSession"; sessionId: string }
  | { type: "removeSession"; sessionId: string }
  | { type: "addTodo"; text: string; index?: number }
  | { type: "toggleTodo"; index: number; text: string; done: boolean }
  | { type: "renameTodo"; index: number; text: string; newText: string }
  | { type: "removeTodo"; index: number; text: string }
  | { type: "moveTodo"; index: number; text: string; to: number }
  | { type: "saveDocument"; document: string };

export const TASK_PRIORITIES = ["high", "medium", "low"] as const;

/** The file changed outside the app; the UI reloads instead of failing. */
export function isStaleTaskError(error: unknown): boolean {
  return errorMessage(error).startsWith("stale:");
}

/** The configured folder is missing (unmounted disk, renamed folder). */
export function isMissingRootError(error: unknown): boolean {
  return errorMessage(error).startsWith("not_found:");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The message without its machine-readable prefix. */
export function taskErrorText(error: unknown): string {
  return errorMessage(error).replace(/^(stale|not_found|not_empty):\s*/, "");
}

export const tasksApi = {
  load: (root: string) => invoke<TaskBoard>("tasks_load", { root }),
  init: (root: string) => invoke<TaskBoard>("tasks_init", { root }),
  create: (root: string, column: string, title: string) =>
    invoke<Task>("tasks_create", { root, column, title }),
  update: (root: string, task: Pick<Task, "id" | "path">, edit: TaskEdit) =>
    invoke<Task>("tasks_update", { root, id: task.id, path: task.path, edit }),
  move: (
    root: string,
    task: Pick<Task, "id" | "path">,
    column: string,
    index: number,
  ) =>
    invoke<TaskBoard>("tasks_move", {
      root,
      id: task.id,
      path: task.path,
      column,
      index,
    }),
  reorder: (root: string, column: string, ids: string[]) =>
    invoke<TaskBoard>("tasks_reorder", { root, column, ids }),
  delete: (root: string, task: Pick<Task, "id" | "path">) =>
    invoke<string>("tasks_delete", { root, id: task.id, path: task.path }),
  restore: (root: string, token: string) =>
    invoke<TaskBoard>("tasks_restore", { root, token }),
  flushTrash: (root: string, token?: string) =>
    invoke<void>("tasks_trash_flush", { root, token: token ?? null }),
  addColumn: (root: string, name: string, after?: string) =>
    invoke<TaskBoard>("tasks_column_add", { root, name, after: after ?? null }),
  renameColumn: (root: string, from: string, to: string) =>
    invoke<TaskBoard>("tasks_column_rename", { root, from, to }),
  deleteColumn: (root: string, name: string, moveTo?: string) =>
    invoke<TaskBoard>("tasks_column_delete", {
      root,
      name,
      moveTo: moveTo ?? null,
    }),
  reorderColumns: (root: string, names: string[]) =>
    invoke<TaskBoard>("tasks_column_reorder", { root, names }),
  setDoneColumn: (root: string, name: string | null) =>
    invoke<TaskBoard>("tasks_column_set_done", { root, name }),
};

// ---- the root folder setting ----------------------------------------------

const ROOT_KEY = "monocode.tasksRoot";
export const TASKS_ROOT_CHANGE_EVENT = "monocode:tasks-root-change";

export function loadTasksRoot(): string | null {
  try {
    const value = localStorage.getItem(ROOT_KEY)?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function saveTasksRoot(root: string | null): void {
  try {
    if (root) localStorage.setItem(ROOT_KEY, root);
    else localStorage.removeItem(ROOT_KEY);
  } catch {
    // Storage can be unavailable; the board still works for this session.
  }
  window.dispatchEvent(new CustomEvent(TASKS_ROOT_CHANGE_EVENT));
}

export function subscribeTasksRoot(callback: () => void): () => void {
  window.addEventListener(TASKS_ROOT_CHANGE_EVENT, callback);
  return () => window.removeEventListener(TASKS_ROOT_CHANGE_EVENT, callback);
}

// ---- derived helpers ---------------------------------------------------------

export function todoProgress(task: Pick<Task, "todos">): {
  done: number;
  total: number;
} {
  return {
    done: task.todos.filter((todo) => todo.done).length,
    total: task.todos.length,
  };
}

/** Local calendar date as `YYYY-MM-DD`. */
export function localDateKey(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type DueState = "overdue" | "today" | "upcoming" | null;

export function dueState(
  task: Pick<Task, "due" | "column">,
  doneColumn: string | null,
  today: string = localDateKey(),
): DueState {
  if (!task.due || !/^\d{4}-\d{2}-\d{2}$/.test(task.due)) return null;
  if (doneColumn && task.column === doneColumn) return null;
  if (task.due < today) return "overdue";
  if (task.due === today) return "today";
  return "upcoming";
}

export function allTasks(board: TaskBoard | null): Task[] {
  return board ? board.columns.flatMap((column) => column.tasks) : [];
}
