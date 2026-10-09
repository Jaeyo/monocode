import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GithubRateLimit } from "./githubTasks";

/**
 * What the Inbox knows about the GitHub quota: the last GraphQL budget a batch
 * reported, and the backend's pause after GitHub refused a request.
 */
export type GithubQuota = {
  rateLimit: GithubRateLimit | null;
  /** Unix ms until which the backend refuses GitHub calls; null when not paused. */
  pausedUntil: number | null;
};

/** Below this share of the hourly budget, background refreshes slow down. */
export const GITHUB_QUOTA_LOW_RATIO = 0.1;
const LOW_QUOTA_POLL_FACTOR = 4;

let quota: GithubQuota = { rateLimit: null, pausedUntil: null };
const listeners = new Set<() => void>();

function publish(next: GithubQuota) {
  quota = next;
  for (const listener of listeners) listener();
}

export function githubQuota(): GithubQuota {
  return quota;
}

export function isGithubRateLimitError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes("rate limit") &&
      (text.includes("exceeded") || text.includes("secondary"))) ||
    text.includes("abuse detection")
  );
}

export function githubQuotaLow(rateLimit: GithubRateLimit | null): boolean {
  return (
    !!rateLimit &&
    rateLimit.limit > 0 &&
    rateLimit.remaining / rateLimit.limit < GITHUB_QUOTA_LOW_RATIO
  );
}

/** Background refreshes stretch while the quota is low, so it can recover. */
export function githubPollFactor(): number {
  return githubQuotaLow(quota.rateLimit) ? LOW_QUOTA_POLL_FACTOR : 1;
}

/**
 * Records one GitHub refresh: a reported budget, and on a rate-limit error
 * the backend's pause, which says when requests resume.
 */
export async function recordGithubRefresh(
  rateLimit: GithubRateLimit | null,
  error: string | undefined,
): Promise<void> {
  if (!error || !isGithubRateLimitError(error)) {
    publish({ rateLimit: rateLimit ?? quota.rateLimit, pausedUntil: null });
    return;
  }
  let pausedUntil: number | null = null;
  try {
    const backoff = await invoke<{ until: number } | null>(
      "github_rate_limit_backoff",
    );
    pausedUntil = typeof backoff?.until === "number" ? backoff.until : null;
  } catch {
    // Unknown resume time: the error alone still explains the stale list.
  }
  publish({
    rateLimit: rateLimit ?? quota.rateLimit,
    pausedUntil: pausedUntil ?? Date.now() + 60_000,
  });
}

/** Shown under the GitHub list only when the quota explains what you see. */
export function githubQuotaMessage(
  quota: GithubQuota,
  now: number,
): string | null {
  if (quota.pausedUntil != null && quota.pausedUntil > now) {
    const until = new Date(quota.pausedUntil).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `GitHub rate limit reached · showing saved results until ${until}`;
  }
  const rateLimit = quota.rateLimit;
  if (rateLimit && githubQuotaLow(rateLimit)) {
    return `GitHub quota low · ${rateLimit.remaining.toLocaleString()} of ${rateLimit.limit.toLocaleString()} left · refreshing less often`;
  }
  return null;
}

export function resetGithubQuotaForTests() {
  quota = { rateLimit: null, pausedUntil: null };
  listeners.clear();
}

export function useGithubQuota(): GithubQuota {
  const [state, setState] = useState(quota);
  useEffect(() => {
    const listener = () => setState(quota);
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return state;
}
