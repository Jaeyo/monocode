import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_MAX_AGE_MS,
  clearGithubInboxSnapshots,
  githubSnapshotsCheckedAt,
  refreshGithubRepos,
  type GithubInboxFetchers,
} from "./githubInboxSnapshots";
import type { GithubInboxBatch, GithubWorkItem } from "./githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const OPEN = { assignedToMe: false, state: "open" } as const;

function item(repo: string, number: number): GithubWorkItem {
  return {
    kind: "issue",
    number,
    title: `${repo}#${number}`,
    url: "",
    state: "open",
    updatedAt: "2026-10-09T10:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo,
  };
}

function batch(
  repos: {
    repo: string;
    latest?: string;
    items?: GithubWorkItem[];
    error?: string;
  }[],
  viewer = "maya",
): GithubInboxBatch {
  return {
    repos: repos.map((entry) => ({
      repo: entry.repo,
      items: entry.items ?? [],
      latestUpdatedAt: entry.latest ?? "",
      error: entry.error ?? null,
    })),
    viewer,
    rateLimit: { limit: 5000, remaining: 4000, resetAt: "", cost: 1 },
  };
}

/** Fake GitHub whose newest activity per repository the test can move. */
function fakeGithub(latest: Record<string, string>) {
  const fetchers = {
    list: vi.fn<GithubInboxFetchers["list"]>(async (repos) =>
      batch(
        repos.map((repo) => ({
          repo,
          latest: latest[repo],
          items: [item(repo, Object.keys(latest).indexOf(repo) + 1)],
        })),
      ),
    ),
    probe: vi.fn<GithubInboxFetchers["probe"]>(async (repos) =>
      batch(repos.map((repo) => ({ repo, latest: latest[repo] }))),
    ),
  };
  return fetchers;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  clearGithubInboxSnapshots();
});

describe("GitHub Inbox snapshots", () => {
  it("lists only repositories whose newest activity moved", async () => {
    const latest = { "acme/web": "t1", "acme/api": "t1", "acme/docs": "t1" };
    const github = fakeGithub(latest);
    const repos = Object.keys(latest);

    await refreshGithubRepos(repos, OPEN, github, 1_000);
    expect(github.probe).not.toHaveBeenCalled();
    expect(github.list).toHaveBeenCalledWith(repos, OPEN);

    latest["acme/api"] = "t2";
    const second = await refreshGithubRepos(repos, OPEN, github, 2_000);
    expect(github.probe).toHaveBeenLastCalledWith(repos);
    expect(github.list).toHaveBeenLastCalledWith(["acme/api"], OPEN);
    expect(second.repos.map((entry) => entry.items.length)).toEqual([1, 1, 1]);
    expect(second.rateLimit?.remaining).toBe(4000);

    await refreshGithubRepos(repos, OPEN, github, 3_000);
    expect(github.list).toHaveBeenCalledTimes(2);
    expect(githubSnapshotsCheckedAt(repos, OPEN)).toBe(3_000);
  });

  it("lists an old snapshot again even when the probe would see no change", async () => {
    const github = fakeGithub({ "acme/web": "t1" });
    await refreshGithubRepos(["acme/web"], OPEN, github, 0);
    await refreshGithubRepos(["acme/web"], OPEN, github, SNAPSHOT_MAX_AGE_MS);
    expect(github.probe).not.toHaveBeenCalled();
    expect(github.list).toHaveBeenCalledTimes(2);
  });

  it("lists assigned items directly: one search covers every repository", async () => {
    const github = fakeGithub({ "acme/web": "" });
    const assigned = { assignedToMe: true, state: "open" } as const;
    await refreshGithubRepos(["acme/web"], assigned, github, 0);
    await refreshGithubRepos(["acme/web"], assigned, github, 1);
    expect(github.probe).not.toHaveBeenCalled();
    expect(github.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the last snapshots beside the error when GitHub is unreachable", async () => {
    const github = fakeGithub({ "acme/web": "t1" });
    await refreshGithubRepos(["acme/web"], OPEN, github, 0);
    github.probe.mockRejectedValueOnce(new Error("API rate limit exceeded"));
    const result = await refreshGithubRepos(["acme/web"], OPEN, github, 1);
    expect(result.error).toBe("API rate limit exceeded");
    expect(result.repos[0]!.items).toHaveLength(1);
    expect(github.list).toHaveBeenCalledTimes(1);
  });

  it("drops a repository's snapshot once it can no longer be read", async () => {
    const github = fakeGithub({ "acme/web": "t1" });
    await refreshGithubRepos(["acme/web"], OPEN, github, 0);
    github.probe.mockResolvedValueOnce(
      batch([{ repo: "acme/web", error: "Not found" }]),
    );
    github.list.mockResolvedValueOnce(
      batch([{ repo: "acme/web", error: "Not found" }]),
    );
    const result = await refreshGithubRepos(["acme/web"], OPEN, github, 1);
    expect(result.repos).toEqual([
      { repo: "acme/web", items: [], error: "Not found" },
    ]);
    expect(githubSnapshotsCheckedAt(["acme/web"], OPEN)).toBeNull();
  });

  it("relists everything when another account answers", async () => {
    const github = fakeGithub({ "acme/web": "t1" });
    await refreshGithubRepos(["acme/web"], OPEN, github, 0);
    github.probe.mockResolvedValueOnce(
      batch([{ repo: "acme/web", latest: "t1" }], "lin"),
    );
    await refreshGithubRepos(["acme/web"], OPEN, github, 1);
    expect(github.list).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect snapshots that a clear dropped mid-refresh", async () => {
    const github = fakeGithub({ "acme/web": "t1" });
    let release!: () => void;
    github.list.mockImplementationOnce(
      (repos) =>
        new Promise((resolve) => {
          release = () => resolve(batch(repos.map((repo) => ({ repo }))));
        }),
    );
    const pending = refreshGithubRepos(["acme/web"], OPEN, github, 0);
    await Promise.resolve();
    await Promise.resolve();
    clearGithubInboxSnapshots();
    release();
    await pending;
    expect(githubSnapshotsCheckedAt(["acme/web"], OPEN)).toBeNull();
  });

  it("revalidates the disk cache after a restart instead of listing", async () => {
    const github = fakeGithub({ "acme/web": "t1" });
    await refreshGithubRepos(["acme/web"], OPEN, github, Date.now());
    await Promise.resolve();
    const saves = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "github_inbox_cache_save");
    const saved = (saves.at(-1)![1] as { contents: string }).contents;

    vi.resetModules();
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "github_inbox_cache_load" ? saved : undefined,
    );
    const restarted = await import("./githubInboxSnapshots");
    const fresh = fakeGithub({ "acme/web": "t1" });
    const result = await restarted.refreshGithubRepos(
      ["acme/web"],
      OPEN,
      fresh,
      Date.now(),
    );
    expect(fresh.probe).toHaveBeenCalledTimes(1);
    expect(fresh.list).not.toHaveBeenCalled();
    expect(result.repos[0]!.items).toHaveLength(1);
  });
});
