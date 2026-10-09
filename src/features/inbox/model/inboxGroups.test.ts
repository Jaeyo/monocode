import { beforeEach, describe, expect, it } from "vitest";
import type { InboxItem } from "./githubTasks";
import {
  groupInboxItems,
  inboxListRows,
  loadInboxCollapsedGroups,
  saveInboxCollapsedGroups,
} from "./inboxGroups";

function item(
  overrides: Partial<InboxItem> & Pick<InboxItem, "number" | "updatedAt">,
): InboxItem {
  return {
    kind: "issue",
    title: "Item",
    url: "https://github.com/acme/web/issues/1",
    state: "open",
    labels: [],
    assignees: [],
    draft: false,
    repo: "acme/web",
    projectPath: "/tmp/web",
    provider: "github",
    ...overrides,
  };
}

const never = () => false;

describe("groupInboxItems", () => {
  it("orders groups by their newest item and items by recency", () => {
    const groups = groupInboxItems([
      item({ number: 1, repo: "acme/web", updatedAt: "2026-10-01T00:00:00Z" }),
      item({ number: 2, repo: "acme/api", updatedAt: "2026-10-03T00:00:00Z" }),
      item({ number: 3, repo: "acme/web", updatedAt: "2026-10-02T00:00:00Z" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "acme/api",
      "acme/web",
    ]);
    expect(groups[1]?.items.map((entry) => entry.number)).toEqual([3, 1]);
  });

  it("keeps repositories with the same name in different owners apart", () => {
    const groups = groupInboxItems([
      item({ number: 1, repo: "acme/web", updatedAt: "2026-10-01T00:00:00Z" }),
      item({ number: 2, repo: "fork/web", updatedAt: "2026-10-02T00:00:00Z" }),
    ]);
    expect(groups.map((group) => group.id)).toEqual([
      "github:fork/web",
      "github:acme/web",
    ]);
  });

  it("labels Jira by key and name and Linear by team id", () => {
    const [jira] = groupInboxItems([
      item({
        number: 1,
        provider: "jira",
        repo: "ABC",
        teamName: "Alpha",
        updatedAt: "2026-10-01T00:00:00Z",
      }),
    ]);
    expect(jira).toMatchObject({ id: "jira:ABC", label: "ABC · Alpha" });
    const linear = groupInboxItems([
      item({
        number: 1,
        provider: "linear",
        teamId: "t1",
        teamName: "Core",
        updatedAt: "2026-10-01T00:00:00Z",
      }),
      item({
        number: 2,
        provider: "linear",
        teamId: "t1",
        teamName: "Core (renamed)",
        updatedAt: "2026-09-01T00:00:00Z",
      }),
    ]);
    expect(linear).toHaveLength(1);
    expect(linear[0]).toMatchObject({ id: "linear:t1", label: "Core" });
  });

  it("puts items without a container in a trailing Other group", () => {
    const groups = groupInboxItems([
      item({ number: 1, repo: "", updatedAt: "2026-10-05T00:00:00Z" }),
      item({ number: 2, repo: "acme/web", updatedAt: "2026-10-01T00:00:00Z" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["acme/web", "Other"]);
  });
});

describe("inboxListRows", () => {
  const rows = [
    item({ number: 1, repo: "acme/web", updatedAt: "2026-10-02T00:00:00Z" }),
    item({ number: 2, repo: "acme/api", updatedAt: "2026-10-01T00:00:00Z" }),
  ];

  it("stays flat when grouping is off", () => {
    expect(
      inboxListRows(rows, {
        grouped: false,
        collapsed: new Set(),
        isUnseen: never,
      }).map((row) => row.type),
    ).toEqual(["item", "item"]);
  });

  it("drops the header when only one group exists", () => {
    expect(
      inboxListRows([rows[0]!], {
        grouped: true,
        collapsed: new Set(["github:acme/web"]),
        isUnseen: never,
      }).map((row) => row.type),
    ).toEqual(["item"]);
  });

  it("hides collapsed group items and counts unseen ones", () => {
    const result = inboxListRows(rows, {
      grouped: true,
      collapsed: new Set(["github:acme/web"]),
      isUnseen: (entry) => entry.number === 1,
    });
    expect(result.map((row) => row.type)).toEqual(["group", "group", "item"]);
    expect(result[0]).toMatchObject({ collapsed: true, unseen: 1 });
  });

  it("expands collapsed groups while forced without changing state", () => {
    const collapsed = new Set(["github:acme/web", "github:acme/api"]);
    expect(
      inboxListRows(rows, {
        grouped: true,
        collapsed,
        expandAll: true,
        isUnseen: never,
      }).filter((row) => row.type === "item"),
    ).toHaveLength(2);
    expect(
      inboxListRows(rows, {
        grouped: true,
        collapsed,
        expandedIds: ["github:acme/api"],
        isUnseen: never,
      }).map((row) => row.type),
    ).toEqual(["group", "group", "item"]);
    expect(collapsed.size).toBe(2);
  });
});

function mockLocalStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => data.clear(),
    },
    configurable: true,
  });
}

describe("collapsed group storage", () => {
  beforeEach(mockLocalStorage);

  it("round-trips and ignores malformed data", () => {
    saveInboxCollapsedGroups(new Set(["github:acme/web"]));
    expect([...loadInboxCollapsedGroups()]).toEqual(["github:acme/web"]);
    localStorage.setItem("monocode.inboxCollapsedGroups", "{bad");
    expect(loadInboxCollapsedGroups().size).toBe(0);
  });
});
