import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard, TaskLink } from "./tasks";
import {
  dismissDoneSuggestion,
  isDoneSuggestionDismissed,
  linkStatus,
  refreshLinkStatuses,
  resetLinkStatusesForTests,
  suggestsDone,
} from "./taskLinkStatus";
import {
  recordGithubRefresh,
  resetGithubQuotaForTests,
} from "../../inbox/model/githubRateLimit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mocked = vi.mocked(invoke);

function mockStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
}

const pr = (number: number): TaskLink => ({
  provider: "github",
  repo: "o/r",
  kind: "pr",
  number,
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
});

function task(links: TaskLink[], column = "TODO"): Task {
  return {
    id: "T",
    persisted: true,
    path: `${column}/t.md`,
    column,
    fileName: "t.md",
    title: "t",
    status: "",
    due: null,
    priority: null,
    tags: [],
    links,
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

function board(tasks: Task[]): TaskBoard {
  return {
    root: "/t",
    configured: true,
    doneColumn: "Done",
    warnings: [],
    columns: [
      {
        name: "TODO",
        configured: true,
        exists: true,
        tasks: tasks.filter((t) => t.column === "TODO"),
      },
      {
        name: "Done",
        configured: true,
        exists: true,
        tasks: tasks.filter((t) => t.column === "Done"),
      },
    ],
  };
}

function answer(states: Record<number, string>) {
  return {
    items: Object.entries(states).map(([number, state]) => ({
      repo: "o/r",
      kind: "pr",
      number: Number(number),
      state,
      title: "",
      updatedAt: "",
    })),
    rateLimit: null,
  };
}

describe("task link states", () => {
  beforeEach(() => {
    mockStorage();
    mocked.mockReset();
    resetLinkStatusesForTests();
    resetGithubQuotaForTests();
  });

  it("looks up only unfinished tasks' GitHub links in one request", async () => {
    mocked.mockResolvedValueOnce(answer({ 1: "MERGED" }));
    const linear: TaskLink = { ...pr(9), provider: "linear", kind: "linear" };
    await refreshLinkStatuses(
      board([task([pr(1), linear]), { ...task([pr(2)], "Done"), id: "D" }]),
    );
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith("git_github_item_states", {
      items: [{ repo: "o/r", kind: "pr", number: 1 }],
    });
    expect(linkStatus(pr(1))?.state).toBe("merged");
    expect(linkStatus(pr(2))).toBeNull();
  });

  it("does not ask GitHub while the budget is low", async () => {
    await recordGithubRefresh(
      { limit: 5000, remaining: 10, resetAt: "", cost: 1 },
      undefined,
    );
    await refreshLinkStatuses(board([task([pr(1)])]));
    expect(mocked).not.toHaveBeenCalled();
  });

  it("suggests done once every linked PR has finished, until dismissed", async () => {
    mocked.mockResolvedValueOnce(answer({ 1: "MERGED", 2: "OPEN" }));
    const both = task([pr(1), pr(2)]);
    await refreshLinkStatuses(board([both]));
    expect(suggestsDone(both, "Done")).toBe(false);

    mocked.mockResolvedValueOnce(answer({ 1: "MERGED", 2: "CLOSED" }));
    await refreshLinkStatuses(board([both]));
    expect(suggestsDone(both, "Done")).toBe(true);
    expect(suggestsDone({ ...both, column: "Done" }, "Done")).toBe(false);
    expect(suggestsDone(task([]), "Done")).toBe(false);

    dismissDoneSuggestion(both);
    expect(isDoneSuggestionDismissed(both)).toBe(true);
    // A new PR changes what finished means, so the question comes back.
    mocked.mockResolvedValueOnce(answer({ 3: "MERGED" }));
    const grown = task([pr(1), pr(2), pr(3)]);
    await refreshLinkStatuses(board([grown]));
    expect(isDoneSuggestionDismissed(grown)).toBe(false);
  });
});
