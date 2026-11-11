// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import {
  EXTERNAL_THEME_FILE_KEY,
  EXTERNAL_THEME_VARIABLE_NAMES,
  currentExternalTheme,
  externalThemeError,
  externalThemeScheme,
  externalThemeVariables,
  parseExternalTheme,
  type ExternalTheme,
} from "./externalTheme";
import { applyThemePreference, resolveColorScheme } from "./appearance";

const ANSI = [
  "#1a1b26",
  "#f7768e",
  "#9ece6a",
  "#e0af68",
  "#7aa2f7",
  "#ad8ee6",
  "#449dab",
  "#a9b1d6",
  "#414868",
  "#ff7a93",
  "#b9f27c",
  "#ff9e64",
  "#7da6ff",
  "#bb9af7",
  "#0db9d7",
  "#c0caf5",
];

function variant(background: string) {
  return {
    interface: {
      background,
      surface: "#13141c",
      overlay: "#24283b",
      border: "#414868",
      foreground: "#a9b1d6",
      muted: "#565f89",
      accent: "#7aa2f7",
      selection: "#292e42",
      cursor: "#c0caf5",
      currentLine: "#1f2230",
      search: "#55473a",
      error: "#f7768e",
      warning: "#e0af68",
      success: "#9ece6a",
      info: "#7aa2f7",
    },
    terminal: {
      background,
      foreground: "#a9b1d6",
      cursor: "#c0caf5",
      cursorText: "#1a1b26",
      selectionBackground: "#292e42",
      selectionForeground: "#c0caf5",
      ansi: ANSI,
    },
  };
}

/** What Scene's ThemeFileRenderer writes, for a theme with two looks. */
function sceneFile(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    theme: { id: "scene/tokyo-night", name: "Tokyo Night", version: "1.0.0" },
    mode: "system",
    appearance: "dark",
    variants: { dark: variant("#1a1b26"), light: variant("#f5f5f5") },
    ...overrides,
  };
}

function file(content: unknown) {
  return { name: "scene.json", source: JSON.stringify(content) };
}

function parsed(content: unknown): ExternalTheme {
  const result = parseExternalTheme(file(content));
  if (!result.ok) throw new Error(result.error);
  return result.theme;
}

// Node's own global localStorage hides happy-dom's, as in appearance.test.ts.
beforeEach(() => {
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    },
    configurable: true,
  });
});

afterEach(() => {
  localStorage.clear();
  applyThemePreference("dark");
});

describe("parseExternalTheme", () => {
  it("reads Scene's theme file", () => {
    const theme = parsed(sceneFile());
    expect(theme.name).toBe("Tokyo Night");
    expect(theme.id).toBe("scene/tokyo-night");
    expect(theme.mode).toBe("system");
    expect(theme.variants.dark?.interface.background).toBe("#1a1b26");
    expect(theme.variants.light?.terminal.ansi).toHaveLength(16);
  });

  it("fills syntax colors from the terminal colors when the file has none", () => {
    const syntax = parsed(sceneFile()).variants.dark!.syntax;
    expect(syntax.keyword).toBe("#ad8ee6");
    expect(syntax.string).toBe("#9ece6a");
    expect(syntax.function).toBe("#7aa2f7");
    expect(syntax.comment).toBe("#565f89");
  });

  it("takes syntax colors as strings or as Scene's { color, italic } form", () => {
    const dark = {
      ...variant("#1a1b26"),
      syntax: {
        keyword: "#BB9AF7",
        comment: { color: "#565f89", italic: true },
      },
    };
    const syntax = parsed(sceneFile({ variants: { dark } })).variants.dark!
      .syntax;
    expect(syntax.keyword).toBe("#bb9af7");
    expect(syntax.comment).toBe("#565f89");
  });

  it("accepts a theme with one look", () => {
    const theme = parsed(
      sceneFile({ variants: { light: variant("#ffffff") } }),
    );
    expect(theme.variants.dark).toBeUndefined();
    expect(theme.variants.light).toBeDefined();
  });

  it.each([
    ["an unknown format", sceneFile({ format: 2 }), "format 2"],
    ["no looks", sceneFile({ variants: {} }), "dark or a light"],
    [
      "a color that is not hex",
      sceneFile({
        variants: {
          dark: {
            ...variant("#1a1b26"),
            interface: { ...variant("#1a1b26").interface, accent: "blue" },
          },
        },
      }),
      "interface.accent",
    ],
    [
      "too few ANSI colors",
      sceneFile({
        variants: {
          dark: {
            ...variant("#1a1b26"),
            terminal: {
              ...variant("#1a1b26").terminal,
              ansi: ANSI.slice(0, 8),
            },
          },
        },
      }),
      "16 colors",
    ],
  ])("rejects %s", (_label, content, message) => {
    const result = parseExternalTheme(file(content));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it("rejects text that is not JSON", () => {
    const result = parseExternalTheme({ name: "scene.json", source: "{" });
    expect(result.ok).toBe(false);
  });
});

describe("externalThemeScheme", () => {
  it("follows the system for mode system, and a forced mode otherwise", () => {
    expect(externalThemeScheme(parsed(sceneFile()), "light")).toBe("light");
    expect(
      externalThemeScheme(parsed(sceneFile({ mode: "dark" })), "light"),
    ).toBe("dark");
  });

  it("shows the only look a theme has", () => {
    const darkOnly = parsed(
      sceneFile({ variants: { dark: variant("#000000") } }),
    );
    expect(externalThemeScheme(darkOnly, "light")).toBe("dark");
  });
});

describe("externalThemeVariables", () => {
  it("names only properties the removal list knows", () => {
    const vars = externalThemeVariables(parsed(sceneFile()).variants.dark!);
    expect(Object.keys(vars).sort()).toEqual(
      [...EXTERNAL_THEME_VARIABLE_NAMES].sort(),
    );
    expect(vars["--theme-background"]).toBe("#1a1b26");
    expect(vars["--theme-ansi-15"]).toBe("#c0caf5");
  });
});

describe("applying a stored external theme", () => {
  it("sets its colors and look, and removes them when it goes away", () => {
    localStorage.setItem(
      EXTERNAL_THEME_FILE_KEY,
      JSON.stringify(file(sceneFile({ mode: "light" }))),
    );
    expect(currentExternalTheme()?.name).toBe("Tokyo Night");
    // The theme's mode wins over the user's own preference.
    expect(resolveColorScheme("dark")).toBe("light");

    expect(applyThemePreference("dark")).toBe("light");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--theme-background")).toBe("#f5f5f5");
    expect(root.classList.contains("has-external-theme")).toBe(true);
    expect(root.classList.contains("theme-light")).toBe(true);

    localStorage.removeItem(EXTERNAL_THEME_FILE_KEY);
    expect(applyThemePreference("dark")).toBe("dark");
    expect(root.style.getPropertyValue("--theme-background")).toBe("");
    expect(root.classList.contains("has-external-theme")).toBe(false);
  });

  it("reports a stored file it cannot use and keeps the built-in theme", () => {
    localStorage.setItem(
      EXTERNAL_THEME_FILE_KEY,
      JSON.stringify(file(sceneFile({ format: 9 }))),
    );
    expect(currentExternalTheme()).toBeNull();
    expect(externalThemeError()).toContain("format 9");
    expect(resolveColorScheme("dark")).toBe("dark");
  });
});
