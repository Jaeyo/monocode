import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const DEFAULT_GITHUB_HOST = "github.com";
const GITHUB_HOST_CHANGED = "github_host_changed";

// URL builders are synchronous, so keep the configured host in memory.
let githubHost = DEFAULT_GITHUB_HOST;

/** github.com, or the GitHub Enterprise host chosen in Settings. */
export function getGithubHost(): string {
  return githubHost;
}

export function isGithubDotcom(host = githubHost): boolean {
  return host === DEFAULT_GITHUB_HOST;
}

export function setGithubHostForTests(host: string): void {
  githubHost = host;
}

/** `https://<host>/<owner>/<repo>/<pull|issues>/<number>` for the configured host. */
export function githubWorkItemUrl(
  repo: string,
  kind: "pr" | "issue",
  number: number,
): string {
  return `https://${githubHost}/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`;
}

/** Matches github.com (and www.) or the configured Enterprise host. */
export function isGithubSiteHost(host: string): boolean {
  const normalized = host.replace(/\.$/, "").toLowerCase();
  const bare = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
  return bare === githubHost;
}

/** Load the saved host and follow changes made from any window. */
export function initGithubHost(): Promise<void> {
  void listen<string>(GITHUB_HOST_CHANGED, (event) => {
    if (event.payload) githubHost = event.payload;
  }).catch(() => undefined);
  return invoke<string>("github_host")
    .then((host) => {
      if (host) githubHost = host;
    })
    .catch(() => undefined);
}

/** Save the host; the backend normalizes it and broadcasts the change. */
export async function saveGithubHost(host: string): Promise<string> {
  const saved = await invoke<string>("github_set_host", { host });
  githubHost = saved;
  return saved;
}
