import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composeNoteMessage } from "../../notes/notes";
import type { Task, TaskBoard } from "./tasks";
import {
  defaultTaskProject,
  linkTaskSession,
  taskSessionContext,
} from "./taskSession";
import { chooseTasksRoot, resetTasksStoreForTests } from "./tasksStore";

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
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new EventTarget(),
  });
}

const task: Task = {
  id: "01T",
  persisted: true,
  path: "In Progress/Login.md",
  column: "In Progress",
  fileName: "Login.md",
  title: "Login",
  status: "Waiting on review",
  due: "2026-10-20",
  priority: "high",
  tags: ["auth"],
  links: [
    {
      provider: "github",
      repo: "o/r",
      kind: "pr",
      number: 7,
      url: "https://github.com/o/r/pull/7",
      title: "Fix",
      projectPath: "/code/r",
    },
  ],
  sessions: [],
  project: null,
  todos: [
    { text: "Spec", done: true },
    { text: "Ship", done: false },
  ],
  document: "notes",
  readOnly: false,
  error: null,
  duplicate: false,
  modifiedAt: 0,
};

describe("task sessions", () => {
  beforeEach(() => {
    mockBrowserGlobals();
    mocked.mockReset();
    resetTasksStoreForTests();
  });

  it("describes the task and what the agent may edit", () => {
    const context = taskSessionContext(task, "/tasks/");
    expect(context).toContain("File: /tasks/In Progress/Login.md");
    expect(context).toContain("Status: Waiting on review");
    expect(context).toContain("- o/r#7 Fix — https://github.com/o/r/pull/7");
    expect(context).toContain("- [x] Spec\n- [ ] Ship");
    expect(context).toContain("## Document");
    expect(context).toContain("`status:`");
  });

  it("injects the task as reference data in the first message", () => {
    const message = composeNoteMessage(
      { id: "01T", slug: "", title: "Login", kind: "task", body: "ctx" },
      "",
    );
    expect(message).toBe(
      'Work on this task.\n\n---\nReferenced task "Login":\n\nctx',
    );
  });

  it("starts where the task says, then where its links live", () => {
    expect(defaultTaskProject({ ...task, project: "/p" }, "/fallback")).toBe(
      "/p",
    );
    expect(defaultTaskProject(task, "/fallback")).toBe("/code/r");
    expect(defaultTaskProject({ ...task, links: [] }, "/fallback")).toBe(
      "/fallback",
    );
  });

  it("records the session and its project in the task file", async () => {
    const board: TaskBoard = {
      root: "/tasks",
      configured: true,
      doneColumn: "Done",
      warnings: [],
      columns: [
        { name: "In Progress", configured: true, exists: true, tasks: [task] },
      ],
    };
    mocked.mockResolvedValueOnce(board);
    await chooseTasksRoot("/tasks");
    const withSession = { ...task, sessions: ["S1"] };
    mocked.mockResolvedValueOnce(withSession);
    mocked.mockResolvedValueOnce({ ...withSession, project: "/code/r" });
    await linkTaskSession(
      { id: "01T", taskPath: task.path, sourceCwd: "/code/r" },
      "S1",
    );
    expect(mocked).toHaveBeenCalledWith("tasks_update", {
      root: "/tasks",
      id: "01T",
      path: task.path,
      edit: { type: "addSession", sessionId: "S1" },
    });
    expect(mocked).toHaveBeenLastCalledWith("tasks_update", {
      root: "/tasks",
      id: "01T",
      path: task.path,
      edit: { type: "setProject", project: "/code/r" },
    });
  });
});
