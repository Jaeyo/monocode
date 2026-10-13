import { beforeEach, describe, expect, it } from "vitest";
import { isTodoListOpen, setTodoListOpen } from "./taskViewState";

function mockStorage() {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
}

describe("card todo lists", () => {
  beforeEach(mockStorage);

  it("start folded and remember being opened, per task", () => {
    expect(isTodoListOpen("A")).toBe(false);
    setTodoListOpen("A", true);
    expect(isTodoListOpen("A")).toBe(true);
    expect(isTodoListOpen("B")).toBe(false);
    setTodoListOpen("A", false);
    expect(isTodoListOpen("A")).toBe(false);
  });

  it("treat unreadable storage as folded", () => {
    localStorage.setItem("monocode.tasksTodosOpen", "{not json");
    expect(isTodoListOpen("A")).toBe(false);
  });
});
