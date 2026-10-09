import {
  acquireHarnessBridge,
  killChild,
  resolveCodexBinary,
  spawnChild,
  unwatchChild,
  watchChild,
} from "../../core/child";
import {
  extendTurn,
  keepRecentTurns,
  timestampMs,
  type ExternalSessionImport,
  type ExternalSessionImportInput,
  type ImportedTurn,
} from "../../core/externalSessions";
import { JsonRpcClient } from "../../core/jsonRpc";
import type { HarnessEvent } from "../../core/types";
import {
  asRecord,
  codexSubagentThreadIds,
  mapCodexNotification,
} from "./codexProtocol";

/** Item kinds the importer leaves out: thinking, and images it cannot save. */
const SKIPPED_EVENTS = new Set<HarnessEvent["type"]>([
  "reasoning.delta",
  "reasoning.completed",
  "image.generated",
]);

/**
 * Read a Codex thread with `thread/read`. Unlike `thread/resume`, it does not
 * append to the rollout, so importing leaves the CLI's conversation as it was.
 */
export async function importCodexExternalSession(
  input: ExternalSessionImportInput,
): Promise<ExternalSessionImport> {
  const { path } = await resolveCodexBinary();
  const account = input.providerAccountId ?? "default";
  const id = `codex-import:${account}:${input.providerSessionId}`;
  const release = await acquireHarnessBridge();
  const rpc: JsonRpcClient = new JsonRpcClient(
    id,
    {
      onRequest: (requestId, method) => {
        if (method === "currentTime/read")
          return rpc.respond(requestId, {
            currentTimeAt: Math.floor(Date.now() / 1000),
          });
        return rpc.respondError(requestId, {
          code: -32601,
          message: `Unsupported import request: ${method}`,
        });
      },
    },
    { includeJsonrpc: false, label: "codex-import" },
  );
  watchChild(
    id,
    (line) => rpc.pushLine(line),
    () => rpc.close(new Error("Codex import connection exited")),
  );
  try {
    await spawnChild(
      id,
      path,
      ["app-server"],
      input.cwd,
      { provider: "codex", id: account },
      "codex",
    );
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "monocode", title: "MonoCode", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      30_000,
    );
    await rpc.notify("initialized", undefined);
    const read = await rpc.request<{ thread?: unknown }>(
      "thread/read",
      { threadId: input.providerSessionId, includeTurns: true },
      60_000,
    );
    return codexImportFromThread(read.thread, input.turnLimit);
  } finally {
    rpc.close();
    unwatchChild(id);
    await killChild(id).catch(() => undefined);
    release();
  }
}

/** Rebuild a `thread/read` thread's turns as live harness events. */
export function codexImportFromThread(
  thread: unknown,
  turnLimit?: number,
): ExternalSessionImport {
  const rec = asRecord(thread);
  const turns: ImportedTurn[] = [];
  const agentRows = new Map<string, string>();
  const threadId = typeof rec?.id === "string" ? rec.id : undefined;
  for (const rawTurn of Array.isArray(rec?.turns) ? rec.turns : []) {
    const turn = asRecord(rawTurn);
    if (!turn) continue;
    const startedAt = timestampMs(turn.startedAt);
    const endedAt = timestampMs(turn.completedAt);
    let current: ImportedTurn | undefined;
    for (const rawItem of Array.isArray(turn.items) ? turn.items : []) {
      const item = asRecord(rawItem);
      if (!item) continue;
      if (item.type === "userMessage") {
        const prompt = codexUserText(item);
        if (!prompt) continue;
        // A follow-up sent mid-turn reads as its own prompt.
        current = {
          prompt,
          startedAt: current ? undefined : startedAt,
          events: [],
        };
        turns.push(current);
        continue;
      }
      if (!current) continue;
      current.events.push(...historicalItemEvents(item, agentRows, threadId));
    }
    if (current) extendTurn(current, endedAt);
  }
  const model = typeof rec?.model === "string" && rec.model ? rec.model : undefined;
  return { ...keepRecentTurns(turns, turnLimit), ...(model ? { model } : {}) };
}

function codexUserText(item: Record<string, unknown>): string | null {
  const parts = Array.isArray(item.content) ? item.content : [];
  const text = parts
    .map(asRecord)
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part!.text as string)
    .join("\n")
    .trim();
  return text || null;
}

/**
 * Completed-item events as the live path maps them, minus thinking. Agent
 * rows stay "in progress" live until codex.ts settles them from child
 * threads; in a finished transcript there is nothing left to wait for.
 */
function historicalItemEvents(
  item: Record<string, unknown>,
  agentRows: Map<string, string>,
  threadId: string | undefined,
): HarnessEvent[] {
  const duplicate = claimsKnownAgent(item, agentRows, threadId);
  return mapCodexNotification("item/completed", { item })
    .events.filter((event) => !SKIPPED_EVENTS.has(event.type))
    .filter((event) => !(duplicate && isDuplicateAgentRow(event)))
    .map((event) =>
      (event.type === "tool.started" || event.type === "tool.updated") &&
      (event.status === "in_progress" || event.status === "pending")
        ? { ...event, status: "completed" }
        : event,
    );
}

/**
 * Codex describes one spawned agent through more than one item type. As in
 * bindSubagentThreads (codex.ts), the first row to name a child thread owns
 * it and later ones are duplicates.
 */
function claimsKnownAgent(
  item: Record<string, unknown>,
  agentRows: Map<string, string>,
  threadId: string | undefined,
): boolean {
  if (item.type !== "subAgentActivity" && item.type !== "collabAgentToolCall")
    return false;
  const callId = typeof item.id === "string" ? item.id : undefined;
  if (!callId) return false;
  const children = codexSubagentThreadIds(item).filter((id) => id !== threadId);
  let claimed = 0;
  for (const child of children) {
    const owner = agentRows.get(child);
    if (owner) {
      if (owner !== callId) claimed += 1;
      continue;
    }
    agentRows.set(child, callId);
  }
  return children.length > 0 && claimed === children.length;
}

/** A failed run keeps its own row; a second "running" or "done" is noise. */
function isDuplicateAgentRow(event: HarnessEvent): boolean {
  return (
    (event.type === "tool.started" || event.type === "tool.updated") &&
    event.kind === "agent" &&
    event.status !== "failed"
  );
}
