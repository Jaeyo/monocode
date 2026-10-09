import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  githubPollFactor,
  githubQuota,
  githubQuotaMessage,
  isGithubRateLimitError,
  recordGithubRefresh,
  resetGithubQuotaForTests,
} from "./githubRateLimit";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const budget = (remaining: number) => ({
  limit: 5000,
  remaining,
  resetAt: "2026-10-09T13:00:00Z",
  cost: 1,
});

beforeEach(() => {
  resetGithubQuotaForTests();
  vi.mocked(invoke).mockReset();
});

describe("GitHub quota", () => {
  it("recognizes primary and secondary rate-limit errors only", () => {
    expect(
      isGithubRateLimitError("GraphQL: API rate limit exceeded for user"),
    ).toBe(true);
    expect(
      isGithubRateLimitError("You have exceeded a secondary rate limit"),
    ).toBe(true);
    expect(isGithubRateLimitError("abuse detection mechanism triggered")).toBe(
      true,
    );
    expect(isGithubRateLimitError("Could not resolve to a Repository")).toBe(
      false,
    );
  });

  it("slows background refreshes while the budget is low", async () => {
    await recordGithubRefresh(budget(4000), undefined);
    expect(githubPollFactor()).toBe(1);
    expect(githubQuotaMessage(githubQuota(), Date.now())).toBeNull();
    await recordGithubRefresh(budget(300), undefined);
    expect(githubPollFactor()).toBe(4);
    expect(githubQuotaMessage(githubQuota(), Date.now())).toContain(
      "300 of 5,000 left",
    );
  });

  it("reads the backend pause after a rate-limit error and clears it on success", async () => {
    const until = Date.UTC(2026, 9, 9, 13, 0);
    vi.mocked(invoke).mockResolvedValue({ until, error: "x" });
    await recordGithubRefresh(null, "GraphQL: API rate limit exceeded");
    expect(invoke).toHaveBeenCalledWith("github_rate_limit_backoff");
    expect(githubQuota().pausedUntil).toBe(until);
    expect(githubQuotaMessage(githubQuota(), until - 1)).toContain(
      "rate limit reached",
    );
    expect(githubQuotaMessage(githubQuota(), until)).toBeNull();

    await recordGithubRefresh(budget(4000), undefined);
    expect(githubQuota().pausedUntil).toBeNull();
  });

  it("keeps the last budget when a refresh reports none", async () => {
    await recordGithubRefresh(budget(4000), undefined);
    await recordGithubRefresh(null, "offline");
    expect(githubQuota().rateLimit?.remaining).toBe(4000);
    expect(githubQuota().pausedUntil).toBeNull();
  });
});
