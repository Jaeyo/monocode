import { describe, expect, it } from "vitest";
import { foldUnifiedLines, type UnifiedLine } from "./unifiedDiff";
import {
  flattenVisibleRows,
  layoutRows,
  rowsHeight,
  UNIFIED_FOLD_PX,
  UNIFIED_HUNK_PX,
  UNIFIED_LINE_PX,
  unifiedCodeScale,
  unifiedLinePx,
  windowRows,
} from "./unifiedDiffWindow";

describe("unifiedCodeScale", () => {
  it("is exactly 1 at the default size and proportional otherwise", () => {
    expect(unifiedCodeScale(null)).toBe(1);
    expect(unifiedCodeScale(12)).toBe(1);
    expect(unifiedCodeScale(18)).toBe(1.5);
  });
});

describe("unifiedLinePx", () => {
  it("is the stock row height at the default code size", () => {
    expect(unifiedLinePx(null)).toBe(UNIFIED_LINE_PX);
    expect(unifiedLinePx(12)).toBe(UNIFIED_LINE_PX);
  });

  it("scales rows with the code font so text never overlaps", () => {
    expect(unifiedLinePx(10)).toBe(17);
    expect(unifiedLinePx(15)).toBe(25);
    expect(unifiedLinePx(24)).toBe(40);
  });

  it("sizes every line row, folded context included, but not hunk headers", () => {
    const lines: UnifiedLine[] = [
      { kind: "hunk", text: "@@ -1,20 +1,21 @@", oldNumber: null, newNumber: null },
      ...rangeContext(1, 10),
      { kind: "add", text: "new", oldNumber: null, newNumber: 11 },
      ...rangeContext(12, 20),
    ];
    const blocks = foldUnifiedLines(lines, 2);
    const rows = flattenVisibleRows(
      blocks,
      () => ({ start: 3, end: 3 }),
      false,
      30,
    );
    for (const row of rows) {
      if (row.type !== "line") continue;
      expect(row.height).toBe(row.line.kind === "hunk" ? UNIFIED_HUNK_PX : 30);
    }
    expect(rows.filter((row) => row.type === "line").length).toBeGreaterThan(5);
  });
});

describe("flattenVisibleRows", () => {
  it("keeps fold bars and revealed context as separate rows", () => {
    const lines: UnifiedLine[] = [
      ...rangeContext(1, 10),
      { kind: "add", text: "new", oldNumber: null, newNumber: 11 },
      ...rangeContext(12, 20),
    ];
    const blocks = foldUnifiedLines(lines, 2);
    const rows = flattenVisibleRows(blocks, () => undefined);
    expect(rows.some((row) => row.type === "fold")).toBe(true);
    expect(rows.some((row) => row.type === "line" && row.line.text === "new")).toBe(
      true,
    );
  });

  it("marks every changed line in a hunk as stageable", () => {
    const rows = flattenVisibleRows(
      [
        {
          kind: "hunk",
          pos: 4,
          lines: [
            { kind: "del", text: "old", oldNumber: 1, newNumber: null },
            { kind: "add", text: "new", oldNumber: null, newNumber: 1 },
          ],
        },
      ],
      () => undefined,
      true,
    );
    const staged = rows.filter((row) => row.type === "line" && row.stage);
    expect(staged).toHaveLength(2);
    expect(staged.map((row) => row.type === "line" && row.line.kind)).toEqual([
      "del",
      "add",
    ]);
    expect(staged.map((row) => row.type === "line" && row.line.pos)).toEqual([
      4,
      4,
    ]);
  });
});

describe("windowRows", () => {
  it("keeps total height stable across a window", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      type: "line" as const,
      stage: false,
      height: UNIFIED_LINE_PX,
      line: {
        kind: "context" as const,
        text: `l${index}`,
        oldNumber: index + 1,
        newNumber: index + 1,
      },
    }));
    const window = windowRows(rows, 400, 800, 100);
    expect(window.padTop + window.padBottom + rowsHeight(rows.slice(window.start, window.end))).toBe(
      rowsHeight(rows),
    );
    expect(window.start).toBeGreaterThan(0);
    expect(window.end).toBeLessThan(rows.length);
  });

  it("renders nothing when the viewport is still above the file", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      type: "line" as const,
      stage: false,
      height: UNIFIED_LINE_PX,
      line: {
        kind: "context" as const,
        text: `l${index}`,
        oldNumber: index + 1,
        newNumber: index + 1,
      },
    }));
    expect(windowRows(rows, -2000, -1600, 100)).toEqual({
      start: 0,
      end: 0,
      padTop: 0,
      padBottom: rowsHeight(rows),
    });
  });

  it("returns an empty slice when the view is below the last row", () => {
    const rows = [
      {
        type: "fold" as const,
        id: "fold-0",
        hidden: 12,
        height: UNIFIED_FOLD_PX,
      },
    ];
    const window = windowRows(rows, 400, 800, 0);
    expect(window).toEqual({
      start: 1,
      end: 1,
      padTop: UNIFIED_FOLD_PX,
      padBottom: 0,
    });
  });

  it("reuses cumulative layout for exact mixed-height boundaries", () => {
    const rows = [
      {
        type: "line" as const,
        stage: false,
        height: UNIFIED_LINE_PX,
        line: {
          kind: "context" as const,
          text: "one",
          oldNumber: 1,
          newNumber: 1,
        },
      },
      {
        type: "fold" as const,
        id: "fold-0",
        hidden: 10,
        height: UNIFIED_FOLD_PX,
      },
      {
        type: "line" as const,
        stage: false,
        height: UNIFIED_LINE_PX,
        line: {
          kind: "context" as const,
          text: "two",
          oldNumber: 12,
          newNumber: 12,
        },
      },
    ];
    const layout = layoutRows(rows);
    expect(layout.offsets).toEqual([
      0,
      UNIFIED_LINE_PX,
      UNIFIED_LINE_PX + UNIFIED_FOLD_PX,
      UNIFIED_LINE_PX * 2 + UNIFIED_FOLD_PX,
    ]);
    expect(windowRows(rows, UNIFIED_LINE_PX, 40, 0, layout)).toEqual({
      start: 1,
      end: 2,
      padTop: UNIFIED_LINE_PX,
      padBottom: UNIFIED_LINE_PX,
    });
  });
});

function rangeContext(from: number, to: number): UnifiedLine[] {
  const lines: UnifiedLine[] = [];
  for (let number = from; number <= to; number += 1) {
    lines.push({
      kind: "context",
      text: `c${number}`,
      oldNumber: number,
      newNumber: number,
    });
  }
  return lines;
}
