import { describe, expect, it } from "vitest";
import type { Task } from "./tasks";
import {
  EMPTY_TASK_FILTER,
  isTaskFilterActive,
  taskMatches,
  type TaskFilter,
} from "./taskFilter";

function task(extra: Partial<Task>): Task {
  return {
    id: "T",
    persisted: true,
    path: "TODO/t.md",
    column: "TODO",
    fileName: "t.md",
    title: "Refactor login flow",
    status: "Waiting on API review",
    due: null,
    priority: null,
    tags: [],
    links: [],
    sessions: [],
    project: null,
    todos: [{ text: "Rotate session keys", done: false }],
    document: "Plan: use **OAuth**",
    readOnly: false,
    error: null,
    duplicate: false,
    modifiedAt: 0,
    ...extra,
  };
}

const filter = (extra: Partial<TaskFilter>): TaskFilter => ({
  ...EMPTY_TASK_FILTER,
  ...extra,
});

describe("task filter", () => {
  it("is inactive by default", () => {
    expect(isTaskFilterActive(EMPTY_TASK_FILTER)).toBe(false);
    expect(isTaskFilterActive(filter({ query: "  " }))).toBe(false);
    expect(isTaskFilterActive(filter({ overdue: true }))).toBe(true);
  });

  it.each(["rlf", "api review", "session keys", "oauth"])(
    "finds %s in the title, status, todos, or document",
    (query) => {
      expect(taskMatches(task({}), filter({ query }), "Done")).toBe(true);
    },
  );

  it("misses text that is nowhere in the task", () => {
    expect(taskMatches(task({}), filter({ query: "billing" }), "Done")).toBe(
      false,
    );
  });

  it("narrows by tag, priority, links, and overdue", () => {
    const tagged = task({
      tags: ["Auth"],
      priority: "High",
      due: "2026-10-01",
    });
    expect(taskMatches(tagged, filter({ tag: "auth" }), "Done")).toBe(true);
    expect(taskMatches(tagged, filter({ tag: "billing" }), "Done")).toBe(false);
    expect(taskMatches(tagged, filter({ priority: "high" }), "Done")).toBe(
      true,
    );
    expect(taskMatches(tagged, filter({ priority: "low" }), "Done")).toBe(
      false,
    );
    expect(taskMatches(tagged, filter({ links: "without" }), "Done")).toBe(
      true,
    );
    expect(taskMatches(tagged, filter({ links: "with" }), "Done")).toBe(false);
    expect(
      taskMatches(tagged, filter({ overdue: true }), "Done", "2026-10-12"),
    ).toBe(true);
    expect(
      taskMatches(
        { ...tagged, column: "Done" },
        filter({ overdue: true }),
        "Done",
        "2026-10-12",
      ),
    ).toBe(false);
  });
});
