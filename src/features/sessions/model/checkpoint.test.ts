import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { checkpointFileLabel, type CheckpointFile } from "./checkpoint";

function file(overrides: Partial<CheckpointFile>): CheckpointFile {
  return {
    path: "/vault/notes/a.md",
    relative: "notes/a.md",
    status: "modified",
    additions: 1,
    deletions: 0,
    exact: true,
    undoable: true,
    ...overrides,
  };
}

describe("checkpointFileLabel", () => {
  it("keeps project files relative", () => {
    expect(checkpointFileLabel(file({}))).toBe("notes/a.md");
  });

  it("leads external files with their repository name", () => {
    expect(
      checkpointFileLabel(
        file({
          path: "/work/module-a/src/x.ts",
          relative: "/work/module-a/src/x.ts",
          root: "/work/module-a",
        }),
      ),
    ).toBe("module-a/src/x.ts");
  });
});
