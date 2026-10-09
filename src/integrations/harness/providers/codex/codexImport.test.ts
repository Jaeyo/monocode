import { describe, expect, it } from "vitest";
import { buildImportedSession } from "../../../../features/sessions/model/externalImport";
import { newSession } from "../../../../features/sessions/model/session";
import { codexImportFromThread } from "./codexImport";

const userMessage = (id: string, text: string) => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text, text_elements: [] }],
});

const thread = {
  id: "01a05feb",
  model: "gpt-5.6-sol",
  turns: [
    {
      id: "turn-1",
      status: "completed",
      startedAt: 1788315647,
      completedAt: 1788315700,
      items: [
        userMessage("u1", "Review the PR"),
        { type: "reasoning", id: "r1", summary: ["private plan"], content: [] },
        {
          type: "commandExecution",
          id: "c1",
          command: "gh pr diff 12",
          cwd: "/w",
          status: "completed",
          aggregatedOutput: "diff --git a/x b/x",
          exitCode: 0,
        },
        {
          type: "collabAgentToolCall",
          id: "a1",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "01a05feb",
          receiverThreadIds: [],
          agentsStates: {},
        },
        { type: "agentMessage", id: "m1", text: "Two risks found." },
        userMessage("u2", "Also check tests"),
        { type: "agentMessage", id: "m2", text: "Tests are missing." },
      ],
    },
    {
      id: "turn-2",
      status: "completed",
      startedAt: 1788316000,
      completedAt: 1788316010,
      items: [userMessage("u3", "Thanks"), { type: "agentMessage", id: "m3", text: "Done." }],
    },
  ],
};

describe("codexImportFromThread", () => {
  it("turns user messages into prompts and replays completed items", () => {
    const imported = codexImportFromThread(thread);

    expect(imported.model).toBe("gpt-5.6-sol");
    expect(imported.omittedTurns).toBe(0);
    expect(imported.turns.map((turn) => turn.prompt)).toEqual([
      "Review the PR",
      "Also check tests",
      "Thanks",
    ]);
    const [first, followUp, last] = imported.turns;
    expect(first.startedAt).toBe(1788315647_000);
    expect(followUp.startedAt).toBeUndefined();
    expect(followUp.endedAt).toBe(1788315700_000);
    expect(last.endedAt).toBe(1788316010_000);
    expect(JSON.stringify(imported)).not.toContain("private plan");
    const tools = first.events.filter((event) => event.type === "tool.updated");
    expect(tools.map((event) => event.callId)).toEqual(["c1", "a1"]);
    expect(tools.every((event) => event.status === "completed")).toBe(true);
  });

  it("keeps the most recent prompts and tolerates malformed threads", () => {
    expect(codexImportFromThread(thread, 1).turns.map((turn) => turn.prompt)).toEqual([
      "Thanks",
    ]);
    expect(codexImportFromThread(thread, 1).omittedTurns).toBe(2);
    expect(codexImportFromThread(undefined)).toEqual({ turns: [], omittedTurns: 0 });
    expect(codexImportFromThread({ turns: [{ items: [{ type: "agentMessage" }] }] }).turns).toEqual(
      [],
    );
  });

  it("keeps one row per child agent, plus failures", () => {
    const activity = (id: string, kind: string) => ({
      type: "subAgentActivity",
      id,
      kind,
      agentThreadId: "child-1",
      agentPath: "/root/review",
    });
    const imported = codexImportFromThread({
      id: "parent",
      turns: [
        {
          items: [
            userMessage("u1", "Spawn a reviewer"),
            activity("s1", "started"),
            activity("s2", "interacted"),
            activity("s3", "completed"),
            activity("s4", "interrupted"),
          ],
        },
      ],
    });
    const rows = imported.turns[0].events.flatMap((event) =>
      event.type === "tool.started" || event.type === "tool.updated"
        ? [`${event.callId}:${event.status}`]
        : [],
    );
    expect(rows.some((row) => row.startsWith("s2") || row.startsWith("s3"))).toBe(false);
    expect(rows.some((row) => row.startsWith("s1"))).toBe(true);
    expect(rows.filter((row) => row.startsWith("s4"))).toEqual(["s4:failed"]);
  });

  it("builds a settled Codex session", () => {
    const session = buildImportedSession(
      newSession("codex", "/w"),
      codexImportFromThread(thread),
      { providerSessionId: "01a05feb" },
    );
    expect(session.providerSessionId).toBe("01a05feb");
    expect(session.blocks.every((block) => !block.streaming)).toBe(true);
    expect(session.blocks.filter((block) => block.role === "user")).toHaveLength(3);
    expect(session.blocks.some((block) => block.role === "reasoning")).toBe(false);
    const command = session.blocks.find((block) => block.tool?.callId === "c1");
    expect(command?.tool?.status).toBe("completed");
  });
});
