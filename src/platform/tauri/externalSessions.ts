import { invoke } from "@tauri-apps/api/core";

export type ExternalSessionProvider = "claude" | "codex";

/** A Claude Code or Codex conversation found in the provider's own store. */
export type ExternalSession = {
  provider: ExternalSessionProvider;
  id: string;
  accountId: string;
  cwd: string;
  title: string | null;
  firstPrompt: string | null;
  /** Epoch ms of the transcript's last write. */
  updatedAt: number;
  sizeBytes: number;
};

// Local only: provider stores live on this machine, not a connected one.

export function listExternalSessions(
  provider: ExternalSessionProvider,
  accountIds: string[],
  projectPaths: string[],
  limit?: number,
): Promise<ExternalSession[]> {
  return invoke<ExternalSession[]>("list_external_sessions", {
    provider,
    accountIds,
    projectPaths,
    limit,
  });
}

export function findExternalSession(
  sessionId: string,
  claudeAccountIds: string[],
  codexAccountIds: string[],
): Promise<ExternalSession[]> {
  return invoke<ExternalSession[]>("find_external_session", {
    sessionId,
    claudeAccountIds,
    codexAccountIds,
  });
}

export function readClaudeSessionRecords(
  sessionId: string,
  accountId?: string,
): Promise<unknown[]> {
  return invoke<unknown[]>("read_claude_session_records", {
    sessionId,
    accountId,
  });
}
