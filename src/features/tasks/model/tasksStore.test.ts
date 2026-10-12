import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "./tasks";
import { dueState, localDateKey, todoProgress } from "./tasks";
import {
  chooseTasksRoot,
  moveTask,
  peekTasks,
  refreshTasks,
  resetTasksStoreForTests,
  updateTask,
} from "./tasksStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../shared/ui/Toasts", () => ({ showToast: vi.fn() }));

const mocked = vi.mocked(invoke);

function mockBrowserGlobals() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
}

function task(partial: Partial<Task> & Pick<Task, "id" | "title">): Task {
  return {
    persisted: true,
    path: `TODO/${partial.title}.md`,
    column: "TODO",
    fileName: `${partial.title}.md`,
    status: "",
    due: null,
    priority: null,
    tags: [],
    links: [],
    sessions: [],
    project: null,
    todos: [],
    document: "",
    readOnly: false,
    error: null,
    duplicate: false,
    modifiedAt: 0,
    ...partial,
  };
}

function board(tasks: Task[]): TaskBoard {
  return {
    root: "/tasks",
    configured: true,
    doneColumn: "Done",
    warnings: [],
    columns: [
      { name: "TODO", configured: true, exists: true, tasks },
      { name: "Done", configured: true, exists: true, tasks: [] },
    ],
  };
}

describe("tasks store", () => {
  beforeEach(() => {
    mockBrowserGlobals();
    mocked.mockReset();
    resetTasksStoreForTests();
  });

  it("starts unconfigured without a folder", async () => {
    await refreshTasks();
    expect(peekTasks().status).toBe("unconfigured");
    expect(mocked).not.toHaveBeenCalled();
  });

  it("initialises the chosen folder and remembers it", async () => {
    const a = task({ id: "A", title: "a" });
    mocked.mockResolvedValueOnce(board([a]));
    await chooseTasksRoot("/tasks");
    expect(mocked).toHaveBeenCalledWith("tasks_init", { root: "/tasks" });
    expect(peekTasks().board?.columns[0].tasks).toEqual([a]);
    expect(localStorage.getItem("monocode.tasksRoot")).toBe("/tasks");
  });

  it("marks a missing folder without forgetting it", async () => {
    localStorage.setItem("monocode.tasksRoot", "/gone");
    resetTasksStoreForTests();
    mocked.mockRejectedValueOnce("not_found: /gone does not exist");
    await refreshTasks();
    expect(peekTasks()).toMatchObject({ root: "/gone", status: "missing" });
  });

  it("replaces an edited task in place, even when its id was assigned", async () => {
    const hand = task({ id: "~TODO/hand.md", title: "hand", persisted: false });
    mocked.mockResolvedValueOnce(board([hand]));
    await chooseTasksRoot("/tasks");
    const saved = { ...hand, id: "01NEW", persisted: true, status: "s" };
    mocked.mockResolvedValueOnce(saved);
    await updateTask(hand, { type: "setStatus", status: "s" });
    expect(peekTasks().board?.columns[0].tasks).toEqual([saved]);
  });

  it("reloads instead of failing when the file changed outside the app", async () => {
    const a = task({ id: "A", title: "a" });
    mocked.mockResolvedValueOnce(board([a]));
    await chooseTasksRoot("/tasks");
    const fresh = board([{ ...a, title: "edited elsewhere" }]);
    mocked.mockRejectedValueOnce("stale: the todo changed outside the app");
    mocked.mockResolvedValueOnce(fresh);
    const result = await updateTask(a, {
      type: "toggleTodo",
      index: 0,
      text: "x",
      done: true,
    });
    expect(result).toBeNull();
    expect(mocked).toHaveBeenLastCalledWith("tasks_load", { root: "/tasks" });
    expect(peekTasks().board).toEqual(fresh);
  });

  it("applies writes in the order they were made", async () => {
    const a = task({ id: "A", title: "a" });
    mocked.mockResolvedValueOnce(board([a]));
    await chooseTasksRoot("/tasks");
    let releaseFirst: (value: TaskBoard) => void = () => undefined;
    const first = board([{ ...a, title: "first" }]);
    const second = board([{ ...a, title: "second" }]);
    mocked.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = resolve)),
    );
    mocked.mockResolvedValueOnce(second);
    const one = moveTask(a, "TODO", 0);
    const two = moveTask(a, "TODO", 0);
    await Promise.resolve();
    releaseFirst(first);
    await Promise.all([one, two]);
    expect(peekTasks().board).toEqual(second);
  });
});

describe("task helpers", () => {
  it("counts todo progress", () => {
    expect(
      todoProgress({
        todos: [
          { text: "a", done: true },
          { text: "b", done: false },
        ],
      }),
    ).toEqual({ done: 1, total: 2 });
  });

  it("classifies due dates, ignoring the done column", () => {
    const today = "2026-10-12";
    expect(dueState({ due: "2026-10-11", column: "TODO" }, "Done", today)).toBe(
      "overdue",
    );
    expect(dueState({ due: today, column: "TODO" }, "Done", today)).toBe(
      "today",
    );
    expect(dueState({ due: "2026-10-13", column: "TODO" }, "Done", today)).toBe(
      "upcoming",
    );
    expect(dueState({ due: "2026-10-11", column: "Done" }, "Done", today)).toBe(
      null,
    );
    expect(dueState({ due: "soon", column: "TODO" }, "Done", today)).toBe(null);
  });

  it("formats local dates", () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
