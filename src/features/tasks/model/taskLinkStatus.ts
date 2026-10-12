import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { peekGithubWorkItem } from "../../inbox/model/githubTasks";
import type { GithubRateLimit } from "../../inbox/model/githubTasks";
import {
  githubQuota,
  githubQuotaLow,
  isGithubRateLimitError,
  recordGithubRefresh,
} from "../../inbox/model/githubRateLimit";
import { allTasks, type Task, type TaskBoard, type TaskLink } from "./tasks";

export type LinkState = "open" | "draft" | "merged" | "closed";

type Known = { state: LinkState; title: string };

type ItemState = {
  repo: string;
  kind: string;
  number: number;
  state: string;
  title: string;
  updatedAt: string;
};

// Answers from the batched lookup, for items the open-only Inbox list lacks.
// Memory only: a link's file never gains fields it did not have.
let fetched = new Map<string, Known>();
let revision = 0;
const listeners = new Set<() => void>();

function emit() {
  revision++;
  for (const listener of listeners) listener();
}

function key(repo: string, kind: string, number: number): string {
  return `${repo.trim().toLowerCase()}:${kind}:${number}`;
}

function isGithubItem(link: TaskLink): link is TaskLink & { number: number } {
  return (
    link.provider === "github" &&
    (link.kind === "pr" || link.kind === "issue") &&
    !!link.repo &&
    typeof link.number === "number"
  );
}

function fromState(state: string, draft = false): LinkState {
  const upper = state.toUpperCase();
  if (upper === "MERGED") return "merged";
  if (upper === "CLOSED") return "closed";
  return draft ? "draft" : "open";
}

/** What is known about a link right now, without any request. */
export function linkStatus(link: TaskLink): Known | null {
  if (!isGithubItem(link)) return null;
  const answer = fetched.get(key(link.repo, link.kind, link.number));
  if (answer) return answer;
  const listed = peekGithubWorkItem(
    link.repo,
    link.kind as "pr" | "issue",
    link.number,
  );
  return listed
    ? { state: fromState(listed.state, listed.draft), title: listed.title }
    : null;
}

export function useLinkStatusRevision(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => revision,
  );
}

function quotaAllows(): boolean {
  const quota = githubQuota();
  if (quota.pausedUntil && quota.pausedUntil > Date.now()) return false;
  return !githubQuotaLow(quota.rateLimit);
}

let inflight: Promise<void> | null = null;

/**
 * Looks up GitHub links that the Inbox list cannot answer, on tasks that are
 * not done yet — one batched request per ~50 items. Runs when Tasks opens and
 * on Refresh; it is skipped while the GitHub budget is low.
 */
export function refreshLinkStatuses(board: TaskBoard | null): Promise<void> {
  if (inflight) return inflight;
  const wanted = new Map<
    string,
    { repo: string; kind: string; number: number }
  >();
  for (const task of allTasks(board)) {
    if (board?.doneColumn && task.column === board.doneColumn) continue;
    for (const link of task.links) {
      if (!isGithubItem(link)) continue;
      const listed = peekGithubWorkItem(
        link.repo,
        link.kind as "pr" | "issue",
        link.number,
      );
      if (listed) continue;
      wanted.set(key(link.repo, link.kind, link.number), {
        repo: link.repo,
        kind: link.kind,
        number: link.number,
      });
    }
  }
  if (wanted.size === 0 || !quotaAllows()) return Promise.resolve();
  inflight = invoke<{ items: ItemState[]; rateLimit: GithubRateLimit | null }>(
    "git_github_item_states",
    { items: [...wanted.values()] },
  )
    .then(async (result) => {
      const next = new Map(fetched);
      for (const item of result.items) {
        next.set(key(item.repo, item.kind, item.number), {
          state: fromState(item.state),
          title: item.title,
        });
      }
      fetched = next;
      emit();
      await recordGithubRefresh(result.rateLimit, undefined);
    })
    .catch(async (error: unknown) => {
      // A rate limit pauses every GitHub caller, the Inbox included; any
      // other failure just leaves the badges unknown.
      const message = String(error);
      if (isGithubRateLimitError(message)) {
        await recordGithubRefresh(null, message).catch(() => undefined);
      }
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * A task whose GitHub pull requests are all merged or closed, outside the
 * done column, is probably finished.
 */
export function suggestsDone(task: Task, doneColumn: string | null): boolean {
  if (!doneColumn || task.column === doneColumn || task.readOnly) return false;
  const prs = task.links.filter(
    (link) => isGithubItem(link) && link.kind === "pr",
  );
  if (prs.length === 0) return false;
  return prs.every((link) => {
    const status = linkStatus(link)?.state;
    return status === "merged" || status === "closed";
  });
}

// ---- dismissing the suggestion ----------------------------------------------

const DISMISSED_KEY = "monocode.tasksDoneDismissed";

/** The suggestion returns if the set of finished PRs changes. */
function suggestionSignature(task: Task): string {
  return task.links
    .filter((link) => isGithubItem(link) && link.kind === "pr")
    .map((link) => `${link.url}=${linkStatus(link)?.state ?? "?"}`)
    .sort()
    .join("|");
}

function readDismissed(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(DISMISSED_KEY) ?? "{}",
    );
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function isDoneSuggestionDismissed(task: Task): boolean {
  return readDismissed()[task.id] === suggestionSignature(task);
}

export function dismissDoneSuggestion(task: Task): void {
  try {
    const next = readDismissed();
    next[task.id] = suggestionSignature(task);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Not remembering the dismissal only means it may be offered again.
  }
  emit();
}

export function resetLinkStatusesForTests(): void {
  fetched = new Map();
  inflight = null;
}
