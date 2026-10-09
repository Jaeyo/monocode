import {
  extendTurn,
  keepRecentTurns,
  timestampMs,
  type ExternalSessionImport,
  type ExternalSessionImportInput,
  type ImportedTurn,
} from "../../core/externalSessions";
import { readClaudeSessionRecords } from "../../../../platform/tauri/externalSessions";
import { isAgentToolName } from "../../core/preview";
import type { HarnessEvent } from "../../core/types";
import {
  asRecord,
  assistantTextBlocks,
  assistantToolUses,
  extractExitPlanModePlan,
  previewFromTool,
  stringField,
  toolKindFromName,
  toolResultsFromUserMessage,
  toolTitle,
} from "./claudeProtocol";

type KnownTool = {
  name: string;
  input: Record<string, unknown>;
  title: string;
};

export async function importClaudeExternalSession(
  input: ExternalSessionImportInput,
): Promise<ExternalSessionImport> {
  const records = await readClaudeSessionRecords(
    input.providerSessionId,
    input.providerAccountId,
  );
  return claudeImportFromRecords(records, input.turnLimit);
}

/**
 * Rebuild a Claude Code transcript (main-thread `user`/`assistant` records of
 * `<config>/projects/<cwd>/<id>.jsonl`) as turns of live harness events.
 * Mirrors handleAssistant/handleUser in claude.ts without the streaming state.
 * Thinking and subagent internals are not replayed.
 */
export function claudeImportFromRecords(
  records: readonly unknown[],
  turnLimit?: number,
): ExternalSessionImport {
  const turns: ImportedTurn[] = [];
  const tools = new Map<string, KnownTool>();
  let current: ImportedTurn | undefined;
  let model: string | undefined;

  for (const value of records) {
    const rec = asRecord(value);
    if (!rec) continue;
    const at = timestampMs(rec.timestamp);
    if (rec.type === "user") {
      const prompt = claudePromptText(rec);
      if (prompt) {
        current = { prompt, startedAt: at, endedAt: at, events: [] };
        turns.push(current);
        continue;
      }
      if (!current) continue;
      current.events.push(...toolResultEvents(rec, tools));
      extendTurn(current, at);
      continue;
    }
    if (rec.type !== "assistant" || !current) continue;
    const message = asRecord(rec.message);
    const recordModel = message ? stringField(message, "model") : undefined;
    // "<synthetic>" marks CLI-made messages such as API errors.
    if (recordModel && !recordModel.startsWith("<")) model = recordModel;
    current.events.push(...assistantEvents(rec, tools));
    extendTurn(current, at);
  }

  return { ...keepRecentTurns(turns, turnLimit), ...(model ? { model } : {}) };
}

/** What the user typed; null for tool results, meta rows and CLI chrome. */
export function claudePromptText(rec: Record<string, unknown>): string | null {
  if (rec.isMeta === true || rec.isCompactSummary === true) return null;
  const content = asRecord(rec.message)?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map(asRecord)
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block!.text as string)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  const command = slashCommandText(text);
  if (command !== undefined) return command;
  if (text.startsWith("<") || text.startsWith("[Request interrupted")) return null;
  return text;
}

/** `<command-name>/review</command-name><command-args>x</command-args>` → `/review x`. */
function slashCommandText(text: string): string | null | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (name === undefined) return undefined;
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  const command = name.startsWith("/") ? name : `/${name}`;
  return args ? `${command} ${args}` : command;
}

function assistantEvents(
  rec: Record<string, unknown>,
  tools: Map<string, KnownTool>,
): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  const text = assistantTextBlocks(rec).join("");
  if (text.trim()) {
    events.push({ type: "message.delta", text }, { type: "message.completed" });
  }
  for (const use of assistantToolUses(rec)) {
    const title = toolTitle(use.name, use.input);
    tools.set(use.id, { name: use.name, input: use.input, title });
    const agentModel = isAgentToolName(use.name)
      ? stringField(use.input, "model")
      : undefined;
    events.push({
      type: "tool.started",
      callId: use.id,
      title,
      kind: toolKindFromName(use.name),
      ...(agentModel ? { agentModel } : {}),
      status: isAgentToolName(use.name) ? "in_progress" : "pending",
      preview: previewFromTool(use.name, use.input),
    });
    if (use.name === "ExitPlanMode") {
      const plan = extractExitPlanModePlan(use.input);
      if (plan) events.push({ type: "plan", text: plan });
    }
  }
  return events;
}

function toolResultEvents(
  rec: Record<string, unknown>,
  tools: Map<string, KnownTool>,
): HarnessEvent[] {
  const events: HarnessEvent[] = [];
  for (const result of toolResultsFromUserMessage(rec)) {
    const tool = tools.get(result.toolUseId);
    if (!tool) continue;
    events.push({
      type: "tool.updated",
      callId: result.toolUseId,
      title: tool.title,
      kind: toolKindFromName(tool.name),
      status: result.isError ? "failed" : "completed",
      detail: result.text || undefined,
      preview: previewFromTool(tool.name, tool.input, result.text),
    });
    if (isAgentToolName(tool.name) && result.text.trim() && !result.isError) {
      events.push({
        type: "agent.step",
        callId: result.toolUseId,
        stepId: `${result.toolUseId}:report`,
        kind: "message",
        text: result.text,
      });
    }
  }
  return events;
}
