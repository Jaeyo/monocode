import { describe, expect, it } from "vitest";
import { buildImportedSession } from "../../../../features/sessions/model/externalImport";
import { newSession } from "../../../../features/sessions/model/session";
import { claudeImportFromRecords, claudePromptText } from "./claudeImport";

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-09-16T00:00:00.000Z",
  message: { role: "user", content },
  ...extra,
});

const assistant = (content: unknown[], model = "claude-opus-5") => ({
  type: "assistant",
  timestamp: "2026-09-16T00:00:05.000Z",
  message: { role: "assistant", model, content },
});

const transcript = [
  user("<local-command-caveat>ignored</local-command-caveat>", { isMeta: true }),
  user("Fix the login bug"),
  assistant([
    { type: "thinking", thinking: "secret" },
    { type: "text", text: "Looking at the handler." },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "npm test", description: "Run tests" },
    },
  ]),
  user([{ type: "tool_result", tool_use_id: "toolu_1", content: "1 failed" }]),
  assistant([
    {
      type: "tool_use",
      id: "toolu_2",
      name: "Read",
      input: { file_path: "/w/src/login.ts" },
    },
  ]),
  user([
    {
      type: "tool_result",
      tool_use_id: "toolu_2",
      is_error: true,
      content: [{ type: "text", text: "not found" }],
    },
  ]),
  assistant([{ type: "text", text: "Fixed." }]),
  user("[Request interrupted by user]"),
  user(
    "<command-name>/review</command-name><command-message>review</command-message><command-args>PR 12</command-args>",
  ),
  assistant([{ type: "text", text: "Reviewing." }], "<synthetic>"),
];

describe("claudePromptText", () => {
  it("keeps typed prompts and slash commands only", () => {
    expect(claudePromptText(user("  hello  "))).toBe("hello");
    expect(claudePromptText(user([{ type: "text", text: "a" }]))).toBe("a");
    expect(claudePromptText(user("x", { isMeta: true }))).toBeNull();
    expect(claudePromptText(user("x", { isCompactSummary: true }))).toBeNull();
    expect(claudePromptText(user("<local-command-stdout>x"))).toBeNull();
    expect(
      claudePromptText(user([{ type: "tool_result", tool_use_id: "t", content: "x" }])),
    ).toBeNull();
    expect(
      claudePromptText(user("<command-name>/compact</command-name><command-args></command-args>")),
    ).toBe("/compact");
  });
});

describe("claudeImportFromRecords", () => {
  it("groups records into prompt turns with tool calls and results", () => {
    const imported = claudeImportFromRecords(transcript);

    expect(imported.omittedTurns).toBe(0);
    expect(imported.model).toBe("claude-opus-5");
    expect(imported.turns.map((turn) => turn.prompt)).toEqual([
      "Fix the login bug",
      "/review PR 12",
    ]);
    const [first] = imported.turns;
    expect(first.startedAt).toBe(Date.parse("2026-09-16T00:00:00.000Z"));
    expect(first.endedAt).toBe(Date.parse("2026-09-16T00:00:05.000Z"));
    expect(first.events.map((event) => event.type)).toEqual([
      "message.delta",
      "message.completed",
      "tool.started",
      "tool.updated",
      "tool.started",
      "tool.updated",
      "message.delta",
      "message.completed",
    ]);
    expect(first.events[3]).toMatchObject({
      callId: "toolu_1",
      status: "completed",
      detail: "1 failed",
    });
    expect(first.events[5]).toMatchObject({ callId: "toolu_2", status: "failed" });
    expect(JSON.stringify(imported)).not.toContain("secret");
  });

  it("keeps only the most recent turns", () => {
    const records = Array.from({ length: 5 }, (_, i) => user(`prompt ${i}`));
    const imported = claudeImportFromRecords(records, 2);
    expect(imported.omittedTurns).toBe(3);
    expect(imported.turns.map((turn) => turn.prompt)).toEqual(["prompt 3", "prompt 4"]);
  });

  it("ignores results whose tool call was never seen", () => {
    const imported = claudeImportFromRecords([
      user("go"),
      user([{ type: "tool_result", tool_use_id: "missing", content: "x" }]),
    ]);
    expect(imported.turns[0].events).toEqual([]);
  });
});

describe("buildImportedSession", () => {
  it("renders settled blocks and binds the provider conversation", () => {
    const base = newSession("claude", "/w");
    const imported = { ...claudeImportFromRecords(transcript), omittedTurns: 4 };

    const session = buildImportedSession(
      base,
      imported,
      { providerSessionId: "bb34", providerAccountId: "work" },
      "Login fix",
    );

    expect(session.providerSessionId).toBe("bb34");
    expect(session.providerAccountId).toBe("work");
    expect(session.title).toBe("Login fix");
    expect(session.busy).toBe(false);
    expect(session.blocks.every((block) => !block.streaming)).toBe(true);
    expect(session.blocks[0]).toMatchObject({ role: "system" });
    expect(session.blocks[0].text).toContain("4 earlier turns");
    const roles = session.blocks.map((block) => block.role);
    expect(roles.filter((role) => role === "user")).toHaveLength(2);
    expect(roles.filter((role) => role === "tool")).toHaveLength(2);
    const firstUser = session.blocks.find((block) => block.role === "user")!;
    expect(firstUser.startedAt).toBe(Date.parse("2026-09-16T00:00:00.000Z"));
    expect(firstUser.durationMs).toBe(5000);
    const tools = session.blocks.filter((block) => block.role === "tool");
    expect(tools.map((block) => block.tool?.status)).toEqual(["completed", "failed"]);
  });

  it("omits the notice when every turn was imported", () => {
    const session = buildImportedSession(
      newSession("claude", "/w"),
      claudeImportFromRecords([user("hi")]),
      { providerSessionId: "id" },
    );
    expect(session.blocks.map((block) => block.role)).toEqual(["user"]);
    expect(session.providerAccountId).toBeUndefined();
  });
});
