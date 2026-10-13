import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "./tasks";
import {
  dueCounts,
  dueReminderText,
  maybeRemindDue,
  saveDueRemindersEnabled,
  TASKS_DUE_NOTIFICATION_ID,
} from "./taskReminders";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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

function task(due: string | null, column = "TODO"): Task {
  return {
    id: `${due}-${column}`,
    persisted: true,
    path: `${column}/x.md`,
    column,
    fileName: "x.md",
    title: "x",
    status: "",
    due,
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
  };
}

const board: TaskBoard = {
  root: "/t",
  configured: true,
  doneColumn: "Done",
  warnings: [],
  columns: [
    {
      name: "TODO",
      configured: true,
      exists: true,
      tasks: [
        task("2026-10-12"),
        task("2026-10-01"),
        task("2026-10-20"),
        task(null),
      ],
    },
    {
      name: "Done",
      configured: true,
      exists: true,
      tasks: [task("2026-10-01", "Done")],
    },
  ],
};

const morning = new Date(2026, 9, 12, 9, 30);

describe("due reminders", () => {
  beforeEach(() => {
    mockBrowserGlobals();
    mocked.mockReset();
    mocked.mockResolvedValue(undefined);
  });

  it("counts tasks due today and overdue, ignoring the done column", () => {
    expect(dueCounts(board, "2026-10-12")).toEqual({ today: 1, overdue: 1 });
    expect(dueReminderText({ today: 2, overdue: 1 })).toBe(
      "2 tasks are due today, 1 overdue",
    );
    expect(dueReminderText({ today: 0, overdue: 3 })).toBe("3 overdue");
  });

  it("sends one bundled notification a day, from 9:00", async () => {
    expect(await maybeRemindDue(board, new Date(2026, 9, 12, 8, 59))).toBe(
      false,
    );
    expect(mocked).not.toHaveBeenCalled();

    expect(await maybeRemindDue(board, morning)).toBe(true);
    expect(mocked).toHaveBeenCalledWith(
      "show_notification",
      expect.objectContaining({
        sessionId: TASKS_DUE_NOTIFICATION_ID,
        body: "1 task is due today, 1 overdue",
      }),
    );
    expect(await maybeRemindDue(board, new Date(2026, 9, 12, 15))).toBe(false);
    expect(await maybeRemindDue(board, new Date(2026, 9, 13, 9))).toBe(true);
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when turned off or when nothing is due", async () => {
    saveDueRemindersEnabled(false);
    expect(await maybeRemindDue(board, morning)).toBe(false);
    saveDueRemindersEnabled(true);
    const calm: TaskBoard = {
      ...board,
      columns: [{ ...board.columns[0], tasks: [task(null)] }],
    };
    expect(await maybeRemindDue(calm, morning)).toBe(false);
    expect(mocked).not.toHaveBeenCalled();
  });
});
