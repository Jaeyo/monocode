import { describe, expect, it } from "vitest";
import { inboxItemKey, type InboxItem } from "../../inbox/model/githubTasks";
import { filterInboxByTask } from "../../inbox/model/inboxFilters";
import type { Task, TaskBoard } from "./tasks";
import {
  taskLinkFromInboxItem,
  taskLinkKey,
  taskPickerOrder,
  tasksByInboxKey,
} from "./taskInbox";

function item(partial: Partial<InboxItem>): InboxItem {
  return {
    kind: "pr",
    number: 7,
    title: "Fix",
    url: "https://github.com/O/R/pull/7",
    state: "open",
    updatedAt: "2026-10-01T00:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo: "O/R",
    projectPath: "/p",
    provider: "github",
    ...partial,
  };
}

function task(
  id: string,
  links: Task["links"],
  extra: Partial<Task> = {},
): Task {
  return {
    id,
    persisted: true,
    path: `TODO/${id}.md`,
    column: "TODO",
    fileName: `${id}.md`,
    title: id,
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
    ...extra,
  };
}

function board(tasks: Task[]): TaskBoard {
  return {
    root: "/t",
    configured: true,
    doneColumn: "Done",
    warnings: [],
    columns: [{ name: "TODO", configured: true, exists: true, tasks }],
  };
}

describe("task links to Inbox items", () => {
  it.each([
    item({}),
    item({ provider: "gitlab", repo: "g/r", kind: "issue", number: 3 }),
    item({
      provider: "linear",
      kind: "linear",
      identifier: "ENG-12",
      id: "uuid",
    }),
    item({ provider: "jira", kind: "jira", identifier: "ABC-1", id: "10001" }),
  ])("matches the item's own key ($provider)", (entry) => {
    expect(taskLinkKey(taskLinkFromInboxItem(entry))).toBe(inboxItemKey(entry));
  });

  it("indexes tasks by the items they link", () => {
    const pr = item({});
    const a = task("a", [taskLinkFromInboxItem(pr)]);
    const b = task("b", [taskLinkFromInboxItem(pr)]);
    const c = task("c", []);
    const map = tasksByInboxKey(board([a, b, c]));
    expect(map.get(inboxItemKey(pr))?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(map.size).toBe(1);
  });

  it("filters the Inbox by task membership", () => {
    const linked = item({ number: 1 });
    const loose = item({ number: 2 });
    const isLinked = (entry: InboxItem) => entry === linked;
    expect(filterInboxByTask([linked, loose], "linked", isLinked)).toEqual([
      linked,
    ]);
    expect(filterInboxByTask([linked, loose], "unlinked", isLinked)).toEqual([
      loose,
    ]);
    expect(filterInboxByTask([linked, loose], "all", isLinked)).toHaveLength(2);
    expect(
      filterInboxByTask([linked, loose], "linked", undefined),
    ).toHaveLength(2);
  });

  it("offers recent, unfinished, editable tasks first", () => {
    const tasks = [
      task("old", [], { modifiedAt: 1 }),
      task("new", [], { modifiedAt: 5 }),
      task("done", [], { modifiedAt: 9, column: "Done" }),
      task("broken", [], { modifiedAt: 9, readOnly: true }),
    ];
    const value = board(tasks);
    expect(taskPickerOrder(value, "", false).map((t) => t.id)).toEqual([
      "new",
      "old",
    ]);
    expect(taskPickerOrder(value, "", true).map((t) => t.id)).toEqual([
      "done",
      "new",
      "old",
    ]);
    expect(taskPickerOrder(value, "OL", false).map((t) => t.id)).toEqual([
      "old",
    ]);
  });
});
