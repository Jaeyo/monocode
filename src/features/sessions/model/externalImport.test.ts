import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SESSION_ACTIVE_MS,
  externalSessionPlacement,
  importedAccountId,
  importedSessionTitle,
  isExternalSessionActive,
  omittedTurnsNotice,
  ownedProviderSessions,
  projectSessionPaths,
} from "./externalImport";

const worktrees = [
  { path: "/repo", branch: "main" },
  { path: "/trees/feature", branch: "feature" },
  { path: "/trees/detached", branch: null },
];

describe("externalSessionPlacement", () => {
  it("places root and worktree sessions under the project", () => {
    expect(externalSessionPlacement("/repo/", "/repo", worktrees)).toEqual({ cwd: "/repo" });
    expect(externalSessionPlacement("/trees/feature", "/repo", worktrees)).toEqual({
      cwd: "/repo",
      worktreeCwd: "/trees/feature",
      branch: "feature",
    });
    expect(externalSessionPlacement("/trees/detached", "/repo", worktrees)).toEqual({
      cwd: "/repo",
      worktreeCwd: "/trees/detached",
    });
  });

  it("rejects sessions from other directories, including subfolders", () => {
    expect(externalSessionPlacement("/elsewhere", "/repo", worktrees)).toBeNull();
    expect(externalSessionPlacement("/repo/src", "/repo", worktrees)).toBeNull();
  });
});

describe("projectSessionPaths", () => {
  it("lists the root once, then other checkouts", () => {
    expect(projectSessionPaths("/repo", worktrees)).toEqual([
      "/repo",
      "/trees/feature",
      "/trees/detached",
    ]);
    expect(projectSessionPaths("/repo", [])).toEqual(["/repo"]);
  });
});

describe("import helpers", () => {
  it("maps the default account to none", () => {
    expect(importedAccountId("default")).toBeUndefined();
    expect(importedAccountId("work")).toBe("work");
  });

  it("flags recently written sessions", () => {
    const now = 10_000_000;
    expect(isExternalSessionActive(now - 1000, now)).toBe(true);
    expect(isExternalSessionActive(now - EXTERNAL_SESSION_ACTIVE_MS, now)).toBe(false);
  });

  it("titles from the CLI title, else a clipped first prompt", () => {
    expect(importedSessionTitle({ title: " Fix login ", firstPrompt: "x" })).toBe("Fix login");
    expect(importedSessionTitle({ title: null, firstPrompt: "short" })).toBe("short");
    expect(importedSessionTitle({ title: null, firstPrompt: "a".repeat(80) })).toBe(
      `${"a".repeat(60)}…`,
    );
    expect(importedSessionTitle({ title: null, firstPrompt: null })).toBeUndefined();
  });

  it("indexes owned provider conversations, first session wins", () => {
    const owned = ownedProviderSessions([
      { id: "s1", providerSessionId: "p1" },
      { id: "s2" },
      { id: "s3", providerSessionId: "p1" },
    ]);
    expect([...owned]).toEqual([["p1", "s1"]]);
  });

  it("words the omitted-turn notice", () => {
    expect(omittedTurnsNotice(1)).toMatch(/^1 earlier turn was/);
    expect(omittedTurnsNotice(3)).toMatch(/^3 earlier turns were/);
  });
});
