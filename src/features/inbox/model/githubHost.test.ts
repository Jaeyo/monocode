import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GITHUB_HOST,
  githubWorkItemUrl,
  isGithubSiteHost,
  setGithubHostForTests,
} from "./githubHost";
import { githubAvatarUrl } from "./githubTasks";
import { githubActionsJobId } from "./githubPrChecks";
import { parseGithubWorkItemUrl } from "../../sessions/model/sessionWorkItem";
import { parseStandaloneHttpUrl } from "../../sessions/model/linkPreview";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  setGithubHostForTests(DEFAULT_GITHUB_HOST);
});

describe("GitHub Enterprise host", () => {
  it("builds and parses work item URLs on the configured host", () => {
    setGithubHostForTests("oss.example.com");
    expect(githubWorkItemUrl("acme/web", "pr", 12)).toBe(
      "https://oss.example.com/acme/web/pull/12",
    );
    expect(
      parseGithubWorkItemUrl("see https://oss.example.com/acme/web/issues/7"),
    ).toEqual({
      kind: "issue",
      repo: "acme/web",
      number: 7,
      url: "https://oss.example.com/acme/web/issues/7",
    });
    expect(
      parseGithubWorkItemUrl("https://github.com/acme/web/pull/1"),
    ).toBeNull();
    expect(
      parseGithubWorkItemUrl("https://ossXexample.com/acme/web/pull/1"),
    ).toBeNull();
  });

  it("recognizes Enterprise links, Actions jobs, and skips avatars", () => {
    setGithubHostForTests("oss.example.com");
    expect(isGithubSiteHost("OSS.example.com.")).toBe(true);
    expect(isGithubSiteHost("github.com")).toBe(false);
    expect(
      parseStandaloneHttpUrl("https://oss.example.com/acme/web/pull/3")
        ?.githubWorkItem,
    ).toEqual({ kind: "pr", repo: "acme/web", number: 3 });
    expect(
      githubActionsJobId(
        "https://oss.example.com/acme/web/actions/runs/9/job/123",
        "acme/web",
      ),
    ).toBe("123");
    expect(
      githubActionsJobId(
        "https://github.com/acme/web/actions/runs/9/job/123",
        "acme/web",
      ),
    ).toBeNull();
    expect(githubAvatarUrl("maya")).toBe("");
  });

  it("keeps github.com behavior by default", () => {
    expect(githubWorkItemUrl("acme/web", "issue", 5)).toBe(
      "https://github.com/acme/web/issues/5",
    );
    expect(githubAvatarUrl("maya")).toBe(
      "https://avatars.githubusercontent.com/maya?s=64",
    );
  });
});
