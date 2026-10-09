import type { HarnessEvent } from "./types";

/** Recent turns rebuilt as blocks; the provider still resumes the whole thread. */
export const EXTERNAL_IMPORT_TURN_LIMIT = 50;

/** One user prompt and what the agent did with it, as live harness events. */
export type ImportedTurn = {
  prompt: string;
  /** Epoch ms of the prompt, when the transcript records it. */
  startedAt?: number;
  /** Epoch ms of the turn's last record. */
  endedAt?: number;
  events: HarnessEvent[];
};

export type ExternalSessionImport = {
  turns: ImportedTurn[];
  /** Older turns left out of `turns` by the limit. */
  omittedTurns: number;
  /** Native model id of the last turn, when the transcript records it. */
  model?: string;
};

export type ExternalSessionImportInput = {
  providerSessionId: string;
  cwd: string;
  providerAccountId?: string;
  turnLimit?: number;
};

export function keepRecentTurns(
  turns: ImportedTurn[],
  limit = EXTERNAL_IMPORT_TURN_LIMIT,
): { turns: ImportedTurn[]; omittedTurns: number } {
  const keep = Math.max(1, limit);
  if (turns.length <= keep) return { turns, omittedTurns: 0 };
  return {
    turns: turns.slice(turns.length - keep),
    omittedTurns: turns.length - keep,
  };
}

/** Records are not always in clock order; a turn ends at its latest one. */
export function extendTurn(turn: ImportedTurn, at: number | undefined): void {
  if (at === undefined) return;
  if (turn.endedAt === undefined || at > turn.endedAt) turn.endedAt = at;
}

export function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Codex reports seconds; anything this small cannot be epoch ms.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}
