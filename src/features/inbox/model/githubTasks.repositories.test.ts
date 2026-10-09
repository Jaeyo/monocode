import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInboxCache,
  githubPrDiff,
  githubRepositories,
  githubWorkItemComment,
  githubWorkItemDetails,
  githubWorkItemThread,
  listInboxItems,
  peekGithubWorkItemDetails,
  skipHiddenProjects,
  type GithubInboxRepo,
  type GithubWorkItem,
} from "./githubTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  clearInboxCache();
  vi.mocked(invoke).mockReset();
});

function workItem(repo: string, kind: "issue" | "pr"): GithubWorkItem {
  return {
    kind,
    number: 10,
    title: `${repo} item`,
    url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/10`,
    state: "open",
    updatedAt: "2026-09-16T08:00:00Z",
    labels: [],
    assignees: [],
    draft: false,
    repo,
  };
}

function batch(repos: { repo: string; items: GithubWorkItem[] }[]) {
  return {
    repos: repos.map(
      (entry): GithubInboxRepo => ({ ...entry, latestUpdatedAt: "" }),
    ),
    viewer: "maya",
    rateLimit: null,
  };
}

describe("GitHub fork repositories", () => {
  it("caches the local repository and parent metadata", async () => {
    vi.mocked(invoke).mockResolvedValue(["maya/web", "acme/web"] as never);

    await expect(githubRepositories("/tmp/web")).resolves.toEqual([
      "maya/web",
      "acme/web",
    ]);
    await expect(githubRepositories("/tmp/web/")).resolves.toEqual([
      "maya/web",
      "acme/web",
    ]);

    const discoveries = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "git_github_repositories");
    expect(discoveries).toEqual([["git_github_repositories", { cwd: "/tmp/web" }]]);
  });

  it("fetches a shared parent once and keeps the preferred local checkout", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown> | undefined;
      if (command === "git_github_repositories") {
        return (
          input?.cwd === "/tmp/fork-a"
            ? ["maya/web", "acme/web"]
            : ["lin/web", "ACME/web"]
        ) as never;
      }
      if (command === "git_github_inbox_items") {
        const repos = input?.repos as string[];
        return batch(
          repos.map((repo) => ({
            repo,
            items:
              repo.toLowerCase() === "acme/web"
                ? [workItem("acme/web", "issue")]
                : [],
          })),
        ) as never;
      }
      if (
        command === "linear_status" ||
        command === "jira_status" ||
        command === "gitlab_status" ||
        command === "azure_devops_status"
      ) {
        return { connected: false } as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await listInboxItems(
      [{ path: "/tmp/fork-a" }, { path: "/tmp/fork-b" }],
      { assignedToMe: false, state: "open", search: "" },
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      repo: "acme/web",
      projectPath: "/tmp/fork-a",
    });
    const listCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "git_github_inbox_items");
    expect(listCalls).toHaveLength(1);
    expect((listCalls[0]![1] as { repos: string[] }).repos).toEqual([
      "maya/web",
      "acme/web",
      "lin/web",
    ]);
  });

  it("keeps the repositories that answered when one fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown> | undefined;
      if (command === "git_github_repositories") {
        return [input?.cwd === "/tmp/web" ? "acme/web" : "acme/gone"] as never;
      }
      if (command === "git_github_inbox_items") {
        const listed = batch([
          { repo: "acme/web", items: [workItem("acme/web", "pr")] },
        ]);
        listed.repos.push({
          repo: "acme/gone",
          items: [],
          latestUpdatedAt: "",
          error: "Could not resolve to a Repository",
        });
        return listed as never;
      }
      return { connected: false } as never;
    });

    const result = await listInboxItems(
      [{ path: "/tmp/web" }, { path: "/tmp/gone" }],
      { assignedToMe: false, state: "open", search: "" },
    );
    expect(result.errors).toEqual({});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      repo: "acme/web",
      projectPath: "/tmp/web",
      provider: "github",
    });
  });

  it("reports an error when repository discovery fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_github_repositories") {
        throw new Error("not a GitHub repository");
      }
      if (
        command === "linear_status" ||
        command === "jira_status" ||
        command === "gitlab_status" ||
        command === "azure_devops_status"
      ) {
        return { connected: false } as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await expect(
      listInboxItems([{ path: "/tmp/local" }], {
        assignedToMe: false,
        state: "open",
        search: "",
      }),
    ).resolves.toEqual({
      items: [],
      errors: { github: "not a GitHub repository" },
    });
  });

  it("preserves the last list while GitHub is rate limited and refreshes it on recovery", async () => {
    let limited = false;
    const projects = [{ path: "/tmp/web" }];
    const query = { assignedToMe: false, state: "open", search: "" } as const;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_github_repositories") return ["acme/web"];
      if (
        command === "git_github_inbox_items" ||
        command === "git_github_inbox_probe"
      ) {
        if (limited)
          throw new Error("GraphQL: API rate limit already exceeded");
        return batch([
          {
            repo: "acme/web",
            items: [workItem("acme/web", "issue"), workItem("acme/web", "pr")],
          },
        ]);
      }
      return { connected: false };
    });
    const initial = await listInboxItems(projects, query);
    limited = true;
    const stale = await listInboxItems(projects, query, { force: true });
    expect(stale.items).toEqual(initial.items);
    expect(stale.errors.github).toContain("rate limit");
    limited = false;
    const recovered = await listInboxItems(projects, query, { force: true });
    expect(recovered.items).toEqual(initial.items);
    expect(recovered.errors).toEqual({});
  });
});

describe("repository-qualified GitHub item operations", () => {
  it("passes the repository through and isolates same-number caches", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown>;
      if (command === "git_github_work_item_details") {
        return { body: String(input.repo), author: "octocat" } as never;
      }
      if (command === "git_github_work_item_thread") {
        return {
          comments: [],
          commits: [],
          truncated: false,
          reviewDecision: "",
          baseRefName: "main",
          headRefName: "feature",
        } as never;
      }
      if (command === "git_github_pr_diff") {
        return {
          additions: 1,
          deletions: 0,
          files: [],
          patch: "diff",
          truncated: false,
        } as never;
      }
      if (command === "git_github_work_item_comment") {
        return "https://github.com/acme/web/issues/10#issuecomment-1" as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await githubWorkItemDetails("/tmp/web", "maya/web", "issue", 10);
    await githubWorkItemDetails("/tmp/web", "acme/web", "issue", 10);
    expect(peekGithubWorkItemDetails("maya/web", "issue", 10)?.body).toBe(
      "maya/web",
    );
    expect(peekGithubWorkItemDetails("acme/web", "issue", 10)?.body).toBe(
      "acme/web",
    );

    await githubWorkItemThread("/tmp/web", "acme/web", "pr", 10);
    await githubPrDiff("/tmp/web", "acme/web", 10);
    await githubWorkItemComment(
      "/tmp/web",
      "acme/web",
      "issue",
      10,
      "Looks good",
    );

    expect(invoke).toHaveBeenCalledWith("git_github_work_item_thread", {
      cwd: "/tmp/web",
      repo: "acme/web",
      kind: "pr",
      number: 10,
    });
    expect(invoke).toHaveBeenCalledWith("git_github_pr_diff", {
      cwd: "/tmp/web",
      repo: "acme/web",
      number: 10,
      fullContext: false,
    });
    expect(invoke).toHaveBeenCalledWith("git_github_work_item_comment", {
      cwd: "/tmp/web",
      repo: "acme/web",
      kind: "issue",
      number: 10,
      body: "Looks good",
      inReplyTo: "",
    });
  });
});

describe("hidden Inbox projects", () => {
  it("are not fetched unless they hold a featured item", async () => {
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const input = args as Record<string, unknown> | undefined;
      if (command === "git_github_repositories") {
        const cwd = String(input?.cwd);
        return [
          cwd === "/tmp/api"
            ? "acme/api"
            : cwd === "/tmp/docs"
              ? "acme/docs"
              : "acme/web",
        ] as never;
      }
      if (command === "git_github_inbox_items") return batch([]) as never;
      if (
        command === "linear_status" ||
        command === "jira_status" ||
        command === "gitlab_status" ||
        command === "azure_devops_status"
      ) {
        return { connected: false } as never;
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await listInboxItems(
      [{ path: "/tmp/web" }, { path: "/tmp/api" }, { path: "/tmp/docs" }],
      {
        assignedToMe: false,
        state: "open",
        search: "",
        hiddenProjects: ["/tmp/api/", "/tmp/docs"],
        featuredKeys: ["github:acme/docs:issue:7"],
      },
    );

    const [, args] = vi
      .mocked(invoke)
      .mock.calls.find(([command]) => command === "git_github_inbox_items")!;
    expect((args as { repos: string[] }).repos).toEqual([
      "acme/web",
      "acme/docs",
    ]);
  });

  it("still fetch a repository that a visible project also checks out", () => {
    expect(
      skipHiddenProjects(
        [
          { path: "/tmp/web-old", repo: "acme/web" },
          { path: "/tmp/web", repo: "acme/web" },
        ],
        { hiddenProjects: ["/tmp/web-old"] },
        "github",
      ),
    ).toEqual([{ path: "/tmp/web", repo: "acme/web" }]);
  });
});
