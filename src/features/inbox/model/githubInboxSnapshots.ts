import { invoke } from "@tauri-apps/api/core";
import { getGithubHost } from "./githubHost";
import { normalizeProjectPath } from "../../projects/model/recents";
import type {
  GithubInboxBatch,
  GithubRateLimit,
  GithubWorkItem,
  InboxQuery,
} from "./githubTasks";

/**
 * Per-repository GitHub Inbox snapshots, kept on disk across restarts. A
 * refresh first probes each repository's newest `updatedAt` (one cheap query
 * for all of them) and lists only the repositories that changed.
 */

const CACHE_VERSION = 1;
/**
 * Deleting or transferring an item does not move a repository's newest
 * `updatedAt`, so even an unchanged snapshot is listed again after this.
 */
export const SNAPSHOT_MAX_AGE_MS = 30 * 60_000;
/** Snapshots of repositories that left the Inbox are dropped after this. */
const SNAPSHOT_RETAIN_MS = 7 * 24 * 60 * 60_000;
/** A checkout rarely changes its GitHub remote; recheck daily. */
const DISCOVERY_MAX_AGE_MS = 24 * 60 * 60_000;

export type RepoSnapshot = {
  repo: string;
  items: GithubWorkItem[];
  latestUpdatedAt: string;
  /** When the items were last listed. */
  listedAt: number;
  /** When the items were last confirmed current, by a listing or a probe. */
  checkedAt: number;
};

type Discovery = { repos: string[]; at: number };

type Stored = {
  version: number;
  host: string;
  viewer: string;
  snapshots: Record<string, RepoSnapshot>;
  discovery: Record<string, Discovery>;
};

type SnapshotQuery = Pick<InboxQuery, "assignedToMe" | "state">;

export type GithubInboxFetchers = {
  list: (
    repos: readonly string[],
    query: SnapshotQuery,
  ) => Promise<GithubInboxBatch>;
  probe: (repos: readonly string[]) => Promise<GithubInboxBatch>;
};

export type GithubRepoRefresh = {
  repos: { repo: string; items: GithubWorkItem[]; error?: string }[];
  rateLimit: GithubRateLimit | null;
  /** Set when GitHub could not be reached; `repos` then hold the last snapshots. */
  error?: string;
};

let host = "";
let viewer = "";
let snapshots = new Map<string, RepoSnapshot>();
let discovery = new Map<string, Discovery>();
let loaded: Promise<void> | null = null;
let generation = 0;
let saveQueued = false;

function reset(nextHost: string) {
  host = nextHost;
  viewer = "";
  snapshots = new Map();
  discovery = new Map();
}

export function snapshotKey(query: SnapshotQuery, repo: string): string {
  return `${query.assignedToMe ? "me" : "any"}:${query.state}:${repo.toLowerCase()}`;
}

/** Reads the disk cache once per window; later calls share that read. */
export function loadGithubInboxSnapshots(): Promise<void> {
  loaded ??= Promise.resolve()
    .then(() => invoke<string | null>("github_inbox_cache_load"))
    .then((raw) => {
      const stored = parseStored(raw);
      if (!stored || stored.host !== getGithubHost()) return;
      host = stored.host;
      viewer = stored.viewer;
      snapshots = new Map(Object.entries(stored.snapshots));
      discovery = new Map(Object.entries(stored.discovery));
    })
    .catch(() => undefined);
  return loaded;
}

function parseStored(raw: unknown): Stored | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (
      parsed.version !== CACHE_VERSION ||
      typeof parsed.host !== "string" ||
      typeof parsed.snapshots !== "object" ||
      typeof parsed.discovery !== "object"
    ) {
      return null;
    }
    return {
      version: CACHE_VERSION,
      host: parsed.host,
      viewer: typeof parsed.viewer === "string" ? parsed.viewer : "",
      snapshots: parsed.snapshots ?? {},
      discovery: parsed.discovery ?? {},
    };
  } catch {
    return null;
  }
}

/** Coalesces the writes of one refresh into a single save. */
function scheduleSave() {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    if (saveQueued) save();
  });
}

function save() {
  saveQueued = false;
  const now = Date.now();
  const stored: Stored = {
    version: CACHE_VERSION,
    host,
    viewer,
    snapshots: Object.fromEntries(
      [...snapshots].filter(
        ([, snapshot]) => now - snapshot.checkedAt < SNAPSHOT_RETAIN_MS,
      ),
    ),
    discovery: Object.fromEntries(discovery),
  };
  try {
    void Promise.resolve(
      invoke("github_inbox_cache_save", { contents: JSON.stringify(stored) }),
    ).catch(() => undefined);
  } catch {
    // The cache is an optimization; the next refresh saves again.
  }
}

/** Forgets everything, on disk too. Settings call this when an account changes. */
export function clearGithubInboxSnapshots() {
  generation += 1;
  reset(getGithubHost());
  // Nothing on disk is worth reading back after a clear.
  loaded = Promise.resolve();
  // Synchronously, so a queued save of the old state cannot land after it.
  save();
}

function ensureHost() {
  const current = getGithubHost();
  if (host !== current) reset(current);
}

export function discoveredRepositories(
  path: string,
  now = Date.now(),
): string[] | undefined {
  ensureHost();
  const entry = discovery.get(normalizeProjectPath(path));
  if (!entry || now - entry.at >= DISCOVERY_MAX_AGE_MS) return undefined;
  return entry.repos;
}

export function rememberDiscovery(
  path: string,
  repos: string[],
  now = Date.now(),
) {
  ensureHost();
  discovery.set(normalizeProjectPath(path), { repos, at: now });
  scheduleSave();
}

/** When GitHub last confirmed `repos`, or null when one was never fetched. */
export function githubSnapshotsCheckedAt(
  repos: readonly string[],
  query: SnapshotQuery,
): number | null {
  let oldest: number | null = null;
  for (const repo of repos) {
    const snapshot = snapshots.get(snapshotKey(query, repo));
    if (!snapshot) return null;
    oldest =
      oldest == null
        ? snapshot.checkedAt
        : Math.min(oldest, snapshot.checkedAt);
  }
  return oldest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Brings `repos` up to date with as few GitHub requests as possible:
 * - assigned items come from one account-wide search, so they are listed;
 * - otherwise a probe compares each repository's newest `updatedAt` with its
 *   snapshot, and only new, changed or old snapshots are listed.
 */
export async function refreshGithubRepos(
  repos: readonly string[],
  query: SnapshotQuery,
  fetchers: GithubInboxFetchers,
  now = Date.now(),
): Promise<GithubRepoRefresh> {
  await loadGithubInboxSnapshots();
  ensureHost();
  const started = generation;
  const errors = new Map<string, string>();
  let rateLimit: GithubRateLimit | null = null;
  let error: string | undefined;

  /** Records the batch's quota; true when it answered for another account. */
  const accept = (batch: GithubInboxBatch): boolean => {
    if (batch.rateLimit) rateLimit = batch.rateLimit;
    const switched = !!batch.viewer && !!viewer && batch.viewer !== viewer;
    // Another account's snapshots must not show under this one.
    if (switched) snapshots = new Map();
    if (batch.viewer) viewer = batch.viewer;
    return switched;
  };

  const toList: string[] = [];
  if (query.assignedToMe) {
    toList.push(...repos);
  } else {
    const toProbe: string[] = [];
    for (const repo of repos) {
      const snapshot = snapshots.get(snapshotKey(query, repo));
      if (!snapshot || now - snapshot.listedAt >= SNAPSHOT_MAX_AGE_MS) {
        toList.push(repo);
      } else {
        toProbe.push(repo);
      }
    }
    if (toProbe.length > 0) {
      try {
        const probe = await fetchers.probe(toProbe);
        if (accept(probe)) toList.push(...toProbe);
        const seen = new Map(
          probe.repos.map((entry) => [entry.repo.toLowerCase(), entry]),
        );
        for (const repo of toProbe) {
          const entry = seen.get(repo.toLowerCase());
          const snapshot = snapshots.get(snapshotKey(query, repo));
          if (toList.includes(repo)) continue;
          if (
            !entry ||
            entry.error ||
            !snapshot ||
            entry.latestUpdatedAt !== snapshot.latestUpdatedAt
          ) {
            toList.push(repo);
          } else {
            snapshot.checkedAt = now;
          }
        }
      } catch (probeError) {
        error = errorMessage(probeError);
      }
    }
  }

  if (!error && toList.length > 0) {
    try {
      const batch = await fetchers.list(toList, query);
      accept(batch);
      // A clear while this was in flight wins over the late answer.
      const entries = started === generation ? batch.repos : [];
      for (const entry of entries) {
        const key = snapshotKey(query, entry.repo);
        if (entry.error) {
          // A repository that can no longer be read must not keep stale items.
          snapshots.delete(key);
          errors.set(entry.repo.toLowerCase(), entry.error);
          continue;
        }
        snapshots.set(key, {
          repo: entry.repo,
          items: entry.items,
          latestUpdatedAt: entry.latestUpdatedAt,
          listedAt: now,
          checkedAt: now,
        });
      }
    } catch (listError) {
      error = errorMessage(listError);
    }
  }

  if (started === generation) scheduleSave();
  return {
    repos: repos.map((repo) => {
      const failed = errors.get(repo.toLowerCase());
      if (failed) return { repo, items: [], error: failed };
      const snapshot = snapshots.get(snapshotKey(query, repo));
      if (snapshot) return { repo, items: snapshot.items };
      return {
        repo,
        items: [],
        error: error ?? "GitHub did not return this repository",
      };
    }),
    rateLimit,
    error,
  };
}
