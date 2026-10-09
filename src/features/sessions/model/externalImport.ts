import {
  appendUser,
  applyHarnessEvents,
  stopStreaming,
} from "../../../integrations/harness/core/apply";
import type { ExternalSessionImport } from "../../../integrations/harness/core/externalSessions";
import { pathKey } from "../../../shared/lib/paths";
import { DEFAULT_PROVIDER_ACCOUNT_ID } from "../../providers/model/providerAccounts";
import type { Session } from "./session";

/** A write this recent probably means the CLI still has the session open. */
export const EXTERNAL_SESSION_ACTIVE_MS = 2 * 60 * 1000;

const TITLE_FROM_PROMPT_CHARS = 60;

export type ProjectCheckout = { path: string; branch?: string | null };

/** Where an imported session lives: the project root or one of its worktrees. */
export type ExternalSessionPlacement = {
  cwd: string;
  worktreeCwd?: string;
  branch?: string;
};

/**
 * Sessions keep the project root as `cwd` and a worktree as `worktreeCwd`.
 * Null when the session was started outside this project.
 */
export function externalSessionPlacement(
  sessionCwd: string,
  projectRoot: string,
  worktrees: readonly ProjectCheckout[],
): ExternalSessionPlacement | null {
  const key = pathKey(sessionCwd);
  if (key === pathKey(projectRoot)) return { cwd: projectRoot };
  const tree = worktrees.find((entry) => pathKey(entry.path) === key);
  if (!tree) return null;
  return {
    cwd: projectRoot,
    worktreeCwd: tree.path,
    ...(tree.branch ? { branch: tree.branch } : {}),
  };
}

/** Paths whose sessions belong to the project, root first. */
export function projectSessionPaths(
  projectRoot: string,
  worktrees: readonly ProjectCheckout[],
): string[] {
  const paths = [projectRoot];
  for (const tree of worktrees) {
    if (!paths.some((path) => pathKey(path) === pathKey(tree.path)))
      paths.push(tree.path);
  }
  return paths;
}

/** MonoCode stores the default profile as "no account". */
export function importedAccountId(accountId: string): string | undefined {
  return accountId === DEFAULT_PROVIDER_ACCOUNT_ID ? undefined : accountId;
}

export function isExternalSessionActive(
  updatedAt: number,
  now = Date.now(),
): boolean {
  return now - updatedAt < EXTERNAL_SESSION_ACTIVE_MS;
}

/** The CLI's title, else the start of the first prompt. */
export function importedSessionTitle(external: {
  title: string | null;
  firstPrompt: string | null;
}): string | undefined {
  const title = external.title?.trim();
  if (title) return title;
  const prompt = external.firstPrompt?.trim();
  if (!prompt) return undefined;
  return prompt.length > TITLE_FROM_PROMPT_CHARS
    ? `${prompt.slice(0, TITLE_FROM_PROMPT_CHARS).trimEnd()}…`
    : prompt;
}

/** Provider conversation id → MonoCode session id, for sessions it already has. */
export function ownedProviderSessions(
  sessions: readonly { id: string; providerSessionId?: string }[],
): Map<string, string> {
  const owned = new Map<string, string>();
  for (const session of sessions) {
    if (session.providerSessionId && !owned.has(session.providerSessionId))
      owned.set(session.providerSessionId, session.id);
  }
  return owned;
}

export function omittedTurnsNotice(count: number): string {
  return count === 1
    ? "1 earlier turn was not imported. The agent still has the full conversation."
    : `${count} earlier turns were not imported. The agent still has the full conversation.`;
}

/**
 * Replay imported turns onto a fresh session, then point it at the provider
 * conversation so the next send resumes it.
 */
export function buildImportedSession(
  base: Session,
  imported: ExternalSessionImport,
  provider: { providerSessionId: string; providerAccountId?: string },
  title?: string,
): Session {
  let session: Session = { ...base, blocks: [] };
  if (imported.omittedTurns > 0) {
    session.blocks = [
      {
        id: crypto.randomUUID(),
        role: "system",
        text: omittedTurnsNotice(imported.omittedTurns),
      },
    ];
  }
  for (const turn of imported.turns) {
    session = appendUser(session, turn.prompt);
    if (turn.startedAt !== undefined) {
      const blocks = session.blocks.slice();
      const last = blocks.length - 1;
      blocks[last] = { ...blocks[last], startedAt: turn.startedAt };
      session = { ...session, blocks };
    }
    session = applyHarnessEvents(session, turn.events);
    session = stopStreaming(session, turn.endedAt ?? turn.startedAt);
  }
  return {
    ...session,
    providerSessionId: provider.providerSessionId,
    ...(provider.providerAccountId
      ? { providerAccountId: provider.providerAccountId }
      : {}),
    ...(title?.trim() ? { title: title.trim() } : {}),
  };
}
