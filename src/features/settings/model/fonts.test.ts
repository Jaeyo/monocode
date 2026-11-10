// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => tauri);

import {
  applyFontSettings,
  FONT_SETTINGS_CHANGE_EVENT,
  fontFamilyCss,
  loadFontFamily,
  loadFontSize,
  loadSystemFonts,
  loadTerminalFontSize,
  normalizeFontSize,
  primaryFontFamily,
  resetFontSettings,
  saveFontFamily,
  saveFontSize,
  subscribeFontSettings,
  TERMINAL_FONT_SIZE_DEFAULT,
  watchFontSettings,
} from "./fonts";

const rootStyle = () => document.documentElement.style;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fontFamilyCss", () => {
  it("is null for an empty setting so the stylesheet default applies", () => {
    expect(fontFamilyCss("", "interface")).toBeNull();
    expect(fontFamilyCss("   ", "code")).toBeNull();
    expect(fontFamilyCss('""', "code")).toBeNull();
  });

  it("quotes a single family and appends the target's built-in stack", () => {
    expect(fontFamilyCss("Pretendard", "interface")).toBe(
      '"Pretendard", var(--font-sans-default)',
    );
    expect(fontFamilyCss("  JetBrains Mono ", "code")).toBe(
      '"JetBrains Mono", var(--font-mono-default)',
    );
    expect(fontFamilyCss("'Fira Code'", "terminal")).toBe(
      '"Fira Code", var(--font-terminal-default)',
    );
  });

  it("escapes quotes and backslashes inside a family name", () => {
    expect(fontFamilyCss('My "Odd" \\ Font', "code")).toBe(
      '"My \\"Odd\\" \\\\ Font", var(--font-mono-default)',
    );
  });

  it("leaves generic families unquoted", () => {
    expect(fontFamilyCss("monospace", "code")).toBe(
      "monospace, var(--font-mono-default)",
    );
    expect(fontFamilyCss("system-ui", "interface")).toBe(
      "system-ui, var(--font-sans-default)",
    );
  });

  it("uses a comma-separated stack exactly as typed", () => {
    expect(fontFamilyCss('"Iosevka Term", Menlo, monospace', "code")).toBe(
      '"Iosevka Term", Menlo, monospace',
    );
  });
});

describe("primaryFontFamily", () => {
  it("returns the first family unquoted", () => {
    expect(primaryFontFamily("")).toBe("");
    expect(primaryFontFamily("Menlo")).toBe("Menlo");
    expect(primaryFontFamily(' "Iosevka Term" , Menlo')).toBe("Iosevka Term");
  });
});

describe("normalizeFontSize", () => {
  it("rounds and clamps to 10-24, treating junk as unset", () => {
    expect(normalizeFontSize(14)).toBe(14);
    expect(normalizeFontSize("15")).toBe(15);
    expect(normalizeFontSize(13.6)).toBe(14);
    expect(normalizeFontSize(2)).toBe(10);
    expect(normalizeFontSize(99)).toBe(24);
    expect(normalizeFontSize(null)).toBeNull();
    expect(normalizeFontSize("")).toBeNull();
    expect(normalizeFontSize("junk")).toBeNull();
  });
});

describe("storage and <html> overrides", () => {
  it("writes overrides only for configured targets", () => {
    saveFontFamily("code", "JetBrains Mono");
    saveFontSize("code", 15);

    expect(rootStyle().getPropertyValue("--font-mono")).toBe(
      '"JetBrains Mono", var(--font-mono-default)',
    );
    expect(rootStyle().getPropertyValue("--font-size-code")).toBe("15px");
    expect(rootStyle().getPropertyValue("--font-sans")).toBe("");
    expect(rootStyle().getPropertyValue("--font-terminal")).toBe("");
  });

  it("clearing a setting removes its override and its stored key", () => {
    saveFontFamily("interface", "Pretendard");
    saveFontFamily("interface", "  ");
    saveFontSize("code", 16);
    saveFontSize("code", null);

    expect(loadFontFamily("interface")).toBe("");
    expect(localStorage.getItem("monocode.fontInterface")).toBeNull();
    expect(loadFontSize("code")).toBeNull();
    expect(localStorage.getItem("monocode.fontSizeCode")).toBeNull();
    expect(rootStyle().getPropertyValue("--font-sans")).toBe("");
    expect(rootStyle().getPropertyValue("--font-size-code")).toBe("");
  });

  it("terminal size defaults to 13 until one is saved", () => {
    expect(loadTerminalFontSize()).toBe(TERMINAL_FONT_SIZE_DEFAULT);
    saveFontSize("terminal", 18);
    expect(loadTerminalFontSize()).toBe(18);
  });

  it("reset clears every font setting", () => {
    saveFontFamily("interface", "Pretendard");
    saveFontFamily("terminal", "Hack Nerd Font Mono");
    saveFontSize("code", 16);
    saveFontSize("terminal", 16);

    resetFontSettings();

    expect(localStorage.length).toBe(0);
    expect(document.documentElement.getAttribute("style") ?? "").toBe("");
  });

  it("applies stored values written before startup", () => {
    localStorage.setItem("monocode.fontTerminal", "Hack Nerd Font Mono");
    applyFontSettings();
    expect(rootStyle().getPropertyValue("--font-terminal")).toBe(
      '"Hack Nerd Font Mono", var(--font-terminal-default)',
    );
  });
});

describe("change notifications", () => {
  it("notifies after a local save, with storage already updated", () => {
    const seen: (number | null)[] = [];
    const unsubscribe = subscribeFontSettings(() =>
      seen.push(loadFontSize("code")),
    );
    saveFontSize("code", 14);
    unsubscribe();
    saveFontSize("code", 15);
    expect(seen).toEqual([14]);
  });

  it("follows another window's save through the storage event", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeFontSettings(onChange);
    const stopWatching = watchFontSettings();

    localStorage.setItem("monocode.fontCode", "Menlo");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "monocode.fontCode" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "monocode.unrelated" }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(rootStyle().getPropertyValue("--font-mono")).toBe(
      '"Menlo", var(--font-mono-default)',
    );
    unsubscribe();
    stopWatching();
  });

  it("uses a plain Event name other modules can listen for", () => {
    const onChange = vi.fn();
    window.addEventListener(FONT_SETTINGS_CHANGE_EVENT, onChange);
    saveFontFamily("code", "Menlo");
    window.removeEventListener(FONT_SETTINGS_CHANGE_EVENT, onChange);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("loadSystemFonts", () => {
  it("is empty outside Tauri without invoking", async () => {
    tauri.isTauri.mockReturnValueOnce(false);
    await expect(loadSystemFonts()).resolves.toEqual([]);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("retries after a failed read, then caches the list", async () => {
    const fonts = [{ family: "Menlo", monospace: true }];
    tauri.invoke
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(fonts);

    await expect(loadSystemFonts()).rejects.toThrow("boom");
    await expect(loadSystemFonts()).resolves.toEqual(fonts);
    await expect(loadSystemFonts()).resolves.toEqual(fonts);
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
    expect(tauri.invoke).toHaveBeenCalledWith("list_system_fonts");
  });
});
