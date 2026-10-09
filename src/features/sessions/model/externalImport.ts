import {
  appendUser,
  applyHarnessEvents,
  stopStreaming,
} from "../../../integrations/harness/core/apply";
import type { ExternalSessionImport } from "../../../integrations/harness/core/externalSessions";
import type { Session } from "./session";

/** Changes this often within this window probably mean the CLI is still open. */
export const EXTERNAL_SESSION_ACTIVE_MS = 2 * 60 * 1000;

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
