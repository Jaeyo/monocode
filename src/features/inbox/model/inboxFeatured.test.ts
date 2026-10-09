import { beforeEach, describe, expect, it } from "vitest";
import {
  featureInboxKey,
  featuredInboxItems,
  featuredKeyProvider,
  loadInboxFeatured,
  missingFeaturedKeys,
  reorderFeaturedKeys,
  saveInboxFeatured,
  subscribeInboxFeatured,
  unfeatureInboxKeys,
} from "./inboxFeatured";
import { inboxItemKey, type InboxItem } from "./githubTasks";

const KEY = "monocode.inboxFeatured";

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
    },
    configurable: true,
  });
}

function item(overrides: Partial<InboxItem> & Pick<InboxItem, "number">): InboxItem {
  return {
    kind: "issue",
    title: "Item",
    url: "",
    state: "open",
    updatedAt: "2026-08-27T10:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo: "acme/web",
    projectPath: "/tmp/web",
    provider: "github",
    ...overrides,
  };
}

const gh1 = item({ number: 1 });
const gh2 = item({ number: 2, kind: "pr" });
const jira = item({
  number: 42,
  provider: "jira",
  id: "10042",
  identifier: "ENG-42",
  repo: "",
  projectPath: "",
});

describe("inbox featured storage", () => {
  beforeEach(() => {
    mockLocalStorage();
  });

  it("round-trips an ordered, de-duplicated key list", () => {
    saveInboxFeatured(["b", "a"]);
    expect(loadInboxFeatured()).toEqual(["b", "a"]);
    localStorage.setItem(KEY, JSON.stringify(["a", "a", 3, "", "b"]));
    expect(loadInboxFeatured()).toEqual(["a", "b"]);
  });

  it("falls back to empty on malformed storage", () => {
    localStorage.setItem(KEY, "{");
    expect(loadInboxFeatured()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify({ a: 1 }));
    expect(loadInboxFeatured()).toEqual([]);
  });

  it("notifies subscribers on save", () => {
    let calls = 0;
    const unsubscribe = subscribeInboxFeatured(() => calls++);
    saveInboxFeatured(["a"]);
    unsubscribe();
    saveInboxFeatured(["b"]);
    expect(calls).toBe(1);
  });
});

describe("featured key edits", () => {
  it("puts a newly featured key on top, also when re-featured", () => {
    expect(featureInboxKey(["a", "b"], "c")).toEqual(["c", "a", "b"]);
    expect(featureInboxKey(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("removes keys", () => {
    expect(unfeatureInboxKeys(["a", "b", "c"], ["a", "c"])).toEqual(["b"]);
  });

  it("reorders only the shown subset and keeps hidden slots", () => {
    // "h" is not in the current list; the shown keys swap around it.
    expect(reorderFeaturedKeys(["a", "h", "b", "c"], ["c", "a", "b"])).toEqual([
      "c",
      "h",
      "a",
      "b",
    ]);
  });
});

describe("featuredInboxItems", () => {
  it("returns present items in featured order", () => {
    const keys = [inboxItemKey(jira), "github:gone:issue:9", inboxItemKey(gh1)];
    expect(featuredInboxItems([gh1, gh2, jira], keys)).toEqual([jira, gh1]);
  });
});

describe("missingFeaturedKeys", () => {
  it("reads the provider from the key prefix", () => {
    expect(featuredKeyProvider(inboxItemKey(jira))).toBe("jira");
    expect(featuredKeyProvider("nope:1")).toBeNull();
  });

  it("counts only keys of providers that settled cleanly", () => {
    const keys = [
      inboxItemKey(gh1),
      "github:acme/web:issue:9",
      "jira:10099",
      "linear:eng-1",
    ];
    expect(missingFeaturedKeys(keys, [gh1], new Set(["github", "jira"]))).toEqual([
      "github:acme/web:issue:9",
      "jira:10099",
    ]);
    expect(missingFeaturedKeys(keys, [gh1], new Set(["github"]))).toEqual([
      "github:acme/web:issue:9",
    ]);
  });
});
