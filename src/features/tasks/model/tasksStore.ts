import { useSyncExternalStore } from "react";
import { showToast } from "../../../shared/ui/Toasts";
import {
  isMissingRootError,
  isStaleTaskError,
  loadTasksRoot,
  saveTasksRoot,
  subscribeTasksRoot,
  taskErrorText,
  tasksApi,
  type Task,
  type TaskBoard,
  type TaskEdit,
} from "./tasks";

export type TasksState = {
  root: string | null;
  board: TaskBoard | null;
  /** `missing`: the configured folder is gone; the setting is kept. */
  status: "unconfigured" | "loading" | "ready" | "missing" | "error";
  error: string | null;
};

let state: TasksState = initialState();
const listeners = new Set<() => void>();

function initialState(): TasksState {
  const root = loadTasksRoot();
  return {
    root,
    board: null,
    status: root ? "loading" : "unconfigured",
    error: null,
  };
}

function setState(next: Partial<TasksState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function peekTasks(): TasksState {
  return state;
}

export function useTasks(): TasksState {
  return useSyncExternalStore(subscribeTasks, peekTasks, peekTasks);
}

// Writes run one at a time, so a slow response never lands on top of a newer
// board, and the folder sees edits in the order the user made them.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

function requireRoot(): string {
  if (!state.root) throw new Error("Choose a tasks folder first");
  return state.root;
}

let loadSeq = 0;

/** Reads the folder again. Never writes to it. */
export function refreshTasks(): Promise<void> {
  const root = state.root;
  if (!root) {
    setState({ board: null, status: "unconfigured", error: null });
    return Promise.resolve();
  }
  const seq = ++loadSeq;
  if (!state.board) setState({ status: "loading" });
  return enqueue(async () => {
    try {
      const board = await tasksApi.load(root);
      if (seq !== loadSeq || state.root !== root) return;
      setState({ board, status: "ready", error: null });
    } catch (error) {
      if (seq !== loadSeq || state.root !== root) return;
      setState({
        board: null,
        status: isMissingRootError(error) ? "missing" : "error",
        error: taskErrorText(error),
      });
    }
  });
}

let started = false;
/** Loads once at app start, and again whenever the folder setting changes. */
export function startTasks(): void {
  if (started) return;
  started = true;
  subscribeTasksRoot(() => {
    const root = loadTasksRoot();
    if (root === state.root) return;
    setState({ root, board: null, status: root ? "loading" : "unconfigured" });
    void refreshTasks();
  });
  void refreshTasks().then(() => {
    // Deletions whose undo window closed while the app was not running.
    if (state.root && state.status === "ready") {
      void tasksApi.flushTrash(state.root).catch(() => undefined);
    }
  });
}

/** Uses `root` as the tasks folder, setting it up if it is new. */
export async function chooseTasksRoot(root: string): Promise<void> {
  const board = await enqueue(() => tasksApi.init(root));
  loadSeq++;
  state = { ...state, root };
  saveTasksRoot(root);
  setState({ root, board, status: "ready", error: null });
}

function setBoard(board: TaskBoard) {
  loadSeq++;
  setState({ board, status: "ready", error: null });
}

function replaceTask(previous: Pick<Task, "id" | "path">, next: Task) {
  const board = state.board;
  if (!board) return;
  let placed = false;
  const columns = board.columns.map((column) => {
    const tasks = column.tasks.flatMap((task) => {
      if (task.id !== previous.id && task.path !== previous.path) return [task];
      if (column.name !== next.column) return [];
      placed = true;
      return [next];
    });
    return { ...column, tasks };
  });
  if (!placed) {
    // The file moved columns outside the app; show it where it is now.
    const target = columns.find((column) => column.name === next.column);
    if (target) target.tasks = [next, ...target.tasks];
  }
  setBoard({ ...board, columns });
}

/** Shared failure handling: a stale edit reloads, anything else is shown. */
async function guarded<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (isStaleTaskError(error)) {
      showToast("The file changed outside MonoCode, so it was reloaded.");
      await refreshTasks();
      return null;
    }
    if (isMissingRootError(error)) {
      await refreshTasks();
      return null;
    }
    showToast(taskErrorText(error), { tone: "error" });
    return null;
  }
}

export function updateTask(task: Task, edit: TaskEdit): Promise<Task | null> {
  return guarded(() =>
    enqueue(async () => {
      const next = await tasksApi.update(requireRoot(), task, edit);
      replaceTask(task, next);
      return next;
    }),
  );
}

export function createTask(
  column: string,
  title: string,
): Promise<Task | null> {
  return guarded(() =>
    enqueue(async () => {
      const root = requireRoot();
      const task = await tasksApi.create(root, column, title);
      setBoard(await tasksApi.load(root));
      return task;
    }),
  );
}

export function moveTask(
  task: Task,
  column: string,
  index: number,
): Promise<TaskBoard | null> {
  return guarded(() =>
    enqueue(async () => {
      const board = await tasksApi.move(requireRoot(), task, column, index);
      setBoard(board);
      return board;
    }),
  );
}

export function reorderTasks(
  column: string,
  ids: string[],
): Promise<TaskBoard | null> {
  return guarded(() =>
    enqueue(async () => {
      const board = await tasksApi.reorder(requireRoot(), column, ids);
      setBoard(board);
      return board;
    }),
  );
}

/** Deletes with an undo window; the file reaches the system trash after it. */
export function deleteTask(task: Task): Promise<string | null> {
  return guarded(() =>
    enqueue(async () => {
      const root = requireRoot();
      const token = await tasksApi.delete(root, task);
      setBoard(await tasksApi.load(root));
      return token;
    }),
  );
}

export function restoreTask(token: string): Promise<TaskBoard | null> {
  return guarded(() =>
    enqueue(async () => {
      const board = await tasksApi.restore(requireRoot(), token);
      setBoard(board);
      return board;
    }),
  );
}

export function flushDeletedTask(token: string): void {
  const root = state.root;
  if (!root) return;
  void enqueue(() => tasksApi.flushTrash(root, token)).catch(() => undefined);
}

type ColumnEdit =
  | { type: "add"; name: string; after?: string }
  | { type: "rename"; from: string; to: string }
  | { type: "delete"; name: string; moveTo?: string }
  | { type: "reorder"; names: string[] }
  | { type: "setDone"; name: string | null };

export function editColumns(edit: ColumnEdit): Promise<TaskBoard | null> {
  return guarded(() =>
    enqueue(async () => {
      const root = requireRoot();
      const board =
        edit.type === "add"
          ? await tasksApi.addColumn(root, edit.name, edit.after)
          : edit.type === "rename"
            ? await tasksApi.renameColumn(root, edit.from, edit.to)
            : edit.type === "delete"
              ? await tasksApi.deleteColumn(root, edit.name, edit.moveTo)
              : edit.type === "reorder"
                ? await tasksApi.reorderColumns(root, edit.names)
                : await tasksApi.setDoneColumn(root, edit.name);
      setBoard(board);
      return board;
    }),
  );
}

/** Test hook: forget everything, as on a fresh launch. */
export function resetTasksStoreForTests(): void {
  state = initialState();
  started = false;
  loadSeq = 0;
  queue = Promise.resolve();
}
