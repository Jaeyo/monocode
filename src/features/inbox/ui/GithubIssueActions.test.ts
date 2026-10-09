// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../model/githubTasks", async (original) => ({
  ...(await original<typeof import("../model/githubTasks")>()),
  githubIssueAction: vi.fn(),
}));

import {
  githubIssueAction,
  type GithubWorkItem,
  type InboxItem,
} from "../model/githubTasks";
import { GithubIssueActions, githubIssueActionFor } from "./InboxView";

let container: HTMLDivElement;
let root: Root;

function issue(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    kind: "issue",
    title: "Add a close button",
    url: "https://github.com/acme/web/issues/7",
    state: "open",
    updatedAt: "2026-09-16T08:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo: "acme/web",
    number: 7,
    projectPath: "/tmp/web",
    provider: "github",
    ...overrides,
  };
}

function buttonNamed(scope: ParentNode, name: string): HTMLButtonElement {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === name,
  )!;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(githubIssueAction).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body
    .querySelectorAll("[data-popover-side]")
    .forEach((element) => element.remove());
  vi.unstubAllGlobals();
});

describe("GitHub issue actions", () => {
  it("offers close for open issues and reopen for closed ones only", () => {
    expect(githubIssueActionFor(issue())).toBe("close");
    expect(githubIssueActionFor(issue({ state: "CLOSED" }))).toBe("reopen");
    expect(githubIssueActionFor(issue({ kind: "pr" }))).toBeNull();
    expect(githubIssueActionFor(issue({ provider: "gitlab" }))).toBeNull();
  });

  it("confirms a close and publishes the fresh state", async () => {
    const item = issue();
    const closed: GithubWorkItem = {
      kind: "issue",
      title: item.title,
      url: item.url,
      state: "closed",
      stateReason: "completed",
      updatedAt: "2026-09-16T08:05:00Z",
      labels: [],
      assignees: [],
      draft: false,
      repo: item.repo,
      number: item.number,
    };
    vi.mocked(githubIssueAction).mockResolvedValue(closed);
    const onChange = vi.fn();
    act(() =>
      root.render(createElement(GithubIssueActions, { item, onChange })),
    );

    act(() => buttonNamed(container, "Close issue").click());
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Close this issue?"]',
    )!;
    expect(dialog.textContent).toContain("close as completed");

    await act(async () => {
      buttonNamed(dialog, "Close issue").click();
      await Promise.resolve();
    });

    expect(githubIssueAction).toHaveBeenCalledWith(
      "/tmp/web",
      "acme/web",
      7,
      "close",
    );
    expect(onChange).toHaveBeenCalledWith({
      ...item,
      ...closed,
      projectPath: "/tmp/web",
      provider: "github",
    });
    expect(
      document.querySelector('[role="dialog"][aria-label="Close this issue?"]'),
    ).toBeNull();
  });

  it("keeps a failed reopen open with GitHub's error", async () => {
    vi.mocked(githubIssueAction).mockRejectedValue(
      new Error("You do not have permission to reopen this issue"),
    );
    act(() =>
      root.render(
        createElement(GithubIssueActions, { item: issue({ state: "closed" }) }),
      ),
    );

    act(() => buttonNamed(container, "Reopen issue").click());
    const dialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Reopen this issue?"]',
    )!;
    await act(async () => {
      buttonNamed(dialog, "Reopen issue").click();
      await Promise.resolve();
    });

    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
      "You do not have permission to reopen this issue",
    );
  });
});
