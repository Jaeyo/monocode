import { useSyncExternalStore } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * User font overrides. Each target maps to one CSS custom property; the
 * built-in stacks live in index.css as `--font-*-default`, and an override
 * is written inline on <html> only while the user has one, so "Default"
 * means exactly the stylesheet's own value.
 */
export type FontTarget = "interface" | "code" | "terminal";
export type FontSizeTarget = "code" | "terminal";

export const FONT_TARGETS: readonly FontTarget[] = [
  "interface",
  "code",
  "terminal",
];

const FAMILY_KEYS: Record<FontTarget, string> = {
  interface: "monocode.fontInterface",
  code: "monocode.fontCode",
  terminal: "monocode.fontTerminal",
};
const SIZE_KEYS: Record<FontSizeTarget, string> = {
  code: "monocode.fontSizeCode",
  terminal: "monocode.fontSizeTerminal",
};
const FAMILY_VARS: Record<FontTarget, string> = {
  interface: "--font-sans",
  code: "--font-mono",
  terminal: "--font-terminal",
};
const DEFAULT_STACK_VARS: Record<FontTarget, string> = {
  interface: "--font-sans-default",
  code: "--font-mono-default",
  terminal: "--font-terminal-default",
};
/** Only the code size is a CSS variable; xterm takes its size from JS. */
const CODE_SIZE_VAR = "--font-size-code";

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZES = Array.from(
  { length: FONT_SIZE_MAX - FONT_SIZE_MIN + 1 },
  (_, i) => FONT_SIZE_MIN + i,
);
/** xterm's size when the user has not picked one. */
export const TERMINAL_FONT_SIZE_DEFAULT = 13;

/** Fired on `window` whenever any font setting changes in this window. */
export const FONT_SETTINGS_CHANGE_EVENT = "monocode:fontsettingschange";

const ALL_KEYS = new Set([
  ...Object.values(FAMILY_KEYS),
  ...Object.values(SIZE_KEYS),
]);

/** CSS generic families and system keywords; quoting them breaks them. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);

function unquote(name: string): string {
  const trimmed = name.trim();
  const quote = trimmed[0];
  if (
    trimmed.length >= 2 &&
    (quote === '"' || quote === "'") &&
    trimmed[trimmed.length - 1] === quote
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(unquote(name).toLowerCase());
}

function quoteFamily(name: string): string {
  if (isGenericFamily(name)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * CSS `font-family` value for a stored setting, or null for the default.
 * A single name gets the built-in stack appended so glyphs it lacks (Hangul,
 * Nerd Font icons) and a since-uninstalled font still fall back cleanly; a
 * comma-separated stack is the user's explicit choice and is used as typed.
 */
export function fontFamilyCss(
  value: string,
  target: FontTarget,
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.includes(",")) return trimmed;
  const name = unquote(trimmed);
  if (!name) return null;
  return `${quoteFamily(name)}, var(${DEFAULT_STACK_VARS[target]})`;
}

/** The family the browser tries first, unquoted; "" for the default. */
export function primaryFontFamily(value: string): string {
  const first = value.split(",")[0] ?? "";
  return unquote(first);
}

export function normalizeFontSize(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(parsed)));
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode / quota
  }
}

export function loadFontFamily(target: FontTarget): string {
  return (read(FAMILY_KEYS[target]) ?? "").trim();
}

export function loadFontSize(target: FontSizeTarget): number | null {
  return normalizeFontSize(read(SIZE_KEYS[target]));
}

export function loadTerminalFontSize(): number {
  return loadFontSize("terminal") ?? TERMINAL_FONT_SIZE_DEFAULT;
}

/** Writes inline overrides on <html> to match storage. */
export function applyFontSettings() {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const target of FONT_TARGETS) {
    const css = fontFamilyCss(loadFontFamily(target), target);
    if (css) style.setProperty(FAMILY_VARS[target], css);
    else style.removeProperty(FAMILY_VARS[target]);
  }
  const codeSize = loadFontSize("code");
  if (codeSize != null) style.setProperty(CODE_SIZE_VAR, `${codeSize}px`);
  else style.removeProperty(CODE_SIZE_VAR);
}

/** Persist first: listeners read storage when the event fires. */
function commit() {
  applyFontSettings();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FONT_SETTINGS_CHANGE_EVENT));
  }
}

export function saveFontFamily(target: FontTarget, value: string) {
  const trimmed = value.trim();
  write(FAMILY_KEYS[target], trimmed ? trimmed : null);
  commit();
}

export function saveFontSize(target: FontSizeTarget, value: number | null) {
  const next = normalizeFontSize(value);
  write(SIZE_KEYS[target], next == null ? null : String(next));
  commit();
}

export function resetFontSettings() {
  for (const key of ALL_KEYS) write(key, null);
  commit();
}

/**
 * Calls back after this window saves a font setting or another window's save
 * lands in localStorage (the `storage` event never fires in the writer).
 */
export function subscribeFontSettings(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || ALL_KEYS.has(event.key)) onChange();
  };
  window.addEventListener(FONT_SETTINGS_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FONT_SETTINGS_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Keeps this window's <html> overrides in step with other windows' saves. */
export function watchFontSettings(): () => void {
  return subscribeFontSettings(applyFontSettings);
}

export function useCodeFontSize(): number | null {
  return useFontSize("code");
}

export function useFontSize(target: FontSizeTarget): number | null {
  return useSyncExternalStore(
    subscribeFontSettings,
    () => loadFontSize(target),
    () => null,
  );
}

export function useFontFamily(target: FontTarget): string {
  return useSyncExternalStore(
    subscribeFontSettings,
    () => loadFontFamily(target),
    () => "",
  );
}

export type SystemFontFamily = { family: string; monospace: boolean };

let systemFonts: Promise<SystemFontFamily[]> | null = null;

/**
 * Installed families, read once per window. Outside Tauri (browser dev) the
 * list is empty and the picker accepts typed names only. A failed read is
 * not cached, so the next open retries.
 */
export function loadSystemFonts(): Promise<SystemFontFamily[]> {
  if (!isTauri()) return Promise.resolve([]);
  systemFonts ??= invoke<SystemFontFamily[]>("list_system_fonts").catch(
    (error: unknown) => {
      systemFonts = null;
      throw error;
    },
  );
  return systemFonts;
}
