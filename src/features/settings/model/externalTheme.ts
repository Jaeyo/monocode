/**
 * A color theme another app writes for MonoCode, such as Scene.
 *
 * The app writes `<app data>/themes/<name>.json` and names it as `colorTheme`
 * in `<app data>/appearance.json`; `src-tauri/src/external_theme.rs` reads it
 * and tells every window when either file changes. The file has the shape of
 * Scene's own theme file (`ThemeFileRenderer`, format 1), plus an optional
 * `syntax` table per look:
 *
 * ```json
 * {
 *   "format": 1,
 *   "theme": { "id": "scene/tokyo-night", "name": "Tokyo Night", "version": "1.0.0" },
 *   "mode": "system" | "light" | "dark",
 *   "variants": {
 *     "dark": {
 *       "interface": { "background": "#1a1b26", ...15 roles },
 *       "terminal": { "background", "foreground", "cursor", "cursorText",
 *                     "selectionBackground", "selectionForeground", "ansi": [16 colors] },
 *       "syntax": { "keyword": "#bb9af7", "comment": { "color": "#565f89", "italic": true }, ... }
 *     },
 *     "light": { ... }
 *   }
 * }
 * ```
 *
 * While a theme is selected it decides the colors and the look: `mode` picks
 * light, dark, or the system's, and a theme with one look always shows it.
 * The built-in hue, saturation, lightness, and Theme settings wait underneath.
 *
 * Every window derives the theme from one localStorage copy of the file, so
 * windows that never talk to Rust (quick composer, floating chat) follow it
 * through the same `storage` event as the other theme settings.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ColorScheme } from "./appearance";

export const EXTERNAL_THEME_FILE_KEY = "monocode.externalThemeFile";
export const EXTERNAL_THEME_CHANGED_EVENT = "monocode:external-theme-changed";
/** Fired on `window` when this window's external theme or its error changes. */
export const EXTERNAL_THEME_STATE_EVENT = "monocode:externalthemestate";

export const INTERFACE_ROLES = [
  "background",
  "surface",
  "overlay",
  "border",
  "foreground",
  "muted",
  "accent",
  "selection",
  "cursor",
  "currentLine",
  "search",
  "error",
  "warning",
  "success",
  "info",
] as const;
export type InterfaceRole = (typeof INTERFACE_ROLES)[number];

const TERMINAL_ROLES = [
  "background",
  "foreground",
  "cursor",
  "cursorText",
  "selectionBackground",
  "selectionForeground",
] as const;
type TerminalRole = (typeof TERMINAL_ROLES)[number];

/** Scene's syntax roles (`SyntaxColors`). */
export const SYNTAX_ROLES = [
  "comment",
  "keyword",
  "operator",
  "punctuation",
  "string",
  "escape",
  "number",
  "constant",
  "function",
  "type",
  "builtin",
  "variable",
  "parameter",
  "property",
  "tag",
  "attribute",
  "added",
  "removed",
  "changed",
] as const;
export type SyntaxRole = (typeof SYNTAX_ROLES)[number];

export type ExternalThemeMode = "system" | ColorScheme;

export type ExternalThemeVariant = {
  interface: Record<InterfaceRole, string>;
  terminal: Record<TerminalRole, string> & { ansi: string[] };
  /** Every role, filled from the terminal colors where the file has none. */
  syntax: Record<SyntaxRole, string>;
};

export type ExternalTheme = {
  /** The file name `colorTheme` names, such as `scene.json`. */
  file: string;
  id: string | null;
  name: string;
  mode: ExternalThemeMode;
  variants: Partial<Record<ColorScheme, ExternalThemeVariant>>;
};

export type ExternalThemeFile = { name: string; source: string };

export type ParseResult =
  { ok: true; theme: ExternalTheme } | { ok: false; error: string };

const HEX_RE = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function color(value: unknown, where: string): string {
  if (typeof value === "string" && HEX_RE.test(value))
    return value.toLowerCase();
  throw new Error(`${where} is not a #rrggbb or #rrggbbaa color`);
}

function parseVariant(value: unknown, look: ColorScheme): ExternalThemeVariant {
  if (!isObject(value)) throw new Error(`variants.${look} is not an object`);
  const ui = value.interface;
  if (!isObject(ui)) throw new Error(`variants.${look}.interface is missing`);
  const iface = Object.fromEntries(
    INTERFACE_ROLES.map((role) => [
      role,
      color(ui[role], `variants.${look}.interface.${role}`),
    ]),
  ) as Record<InterfaceRole, string>;

  const term = value.terminal;
  if (!isObject(term)) throw new Error(`variants.${look}.terminal is missing`);
  const terminal = Object.fromEntries(
    TERMINAL_ROLES.map((role) => [
      role,
      color(term[role], `variants.${look}.terminal.${role}`),
    ]),
  ) as Record<TerminalRole, string>;
  if (!Array.isArray(term.ansi) || term.ansi.length !== 16) {
    throw new Error(`variants.${look}.terminal.ansi needs 16 colors`);
  }
  const ansi = term.ansi.map((entry, index) =>
    color(entry, `variants.${look}.terminal.ansi[${index}]`),
  );

  const given = value.syntax === undefined ? {} : value.syntax;
  if (!isObject(given))
    throw new Error(`variants.${look}.syntax is not an object`);
  const fallback = syntaxFallback(iface, terminal.foreground, ansi);
  const syntax = Object.fromEntries(
    SYNTAX_ROLES.map((role) => {
      const entry = given[role];
      if (entry === undefined) return [role, fallback[role]];
      // Scene's theme format allows { "color": "#…", "italic": true }.
      const raw = isObject(entry) ? entry.color : entry;
      return [role, color(raw, `variants.${look}.syntax.${role}`)];
    }),
  ) as Record<SyntaxRole, string>;

  return { interface: iface, terminal: { ...terminal, ansi }, syntax };
}

/**
 * Syntax colors for a file without them (Scene's own `theme.json` for scripts
 * has none), taken from the ANSI colors so code still matches the theme.
 */
function syntaxFallback(
  ui: Record<InterfaceRole, string>,
  foreground: string,
  ansi: string[],
): Record<SyntaxRole, string> {
  const [, red, green, yellow, blue, magenta, cyan] = ansi;
  return {
    comment: ui.muted,
    keyword: magenta,
    operator: foreground,
    punctuation: ui.muted,
    string: green,
    escape: cyan,
    number: yellow,
    constant: yellow,
    function: blue,
    type: yellow,
    builtin: cyan,
    variable: foreground,
    parameter: foreground,
    property: cyan,
    tag: red,
    attribute: yellow,
    added: ui.success,
    removed: ui.error,
    changed: ui.warning,
  };
}

export function parseExternalTheme(file: ExternalThemeFile): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(file.source);
  } catch (error) {
    return {
      ok: false,
      error: `${file.name} is not valid JSON: ${String(error)}`,
    };
  }
  try {
    if (!isObject(root)) throw new Error("the file is not a JSON object");
    if (root.format !== 1)
      throw new Error(`format ${String(root.format)} is not supported`);
    const meta = isObject(root.theme) ? root.theme : {};
    const name =
      typeof meta.name === "string" && meta.name.trim()
        ? meta.name.trim()
        : file.name.replace(/\.json$/, "");
    const id = typeof meta.id === "string" && meta.id ? meta.id : null;
    const mode: ExternalThemeMode =
      root.mode === "light" || root.mode === "dark" ? root.mode : "system";
    if (!isObject(root.variants)) throw new Error("variants is missing");
    const variants: Partial<Record<ColorScheme, ExternalThemeVariant>> = {};
    for (const look of ["dark", "light"] as const) {
      if (root.variants[look] !== undefined) {
        variants[look] = parseVariant(root.variants[look], look);
      }
    }
    if (!variants.dark && !variants.light) {
      throw new Error("variants needs a dark or a light look");
    }
    return { ok: true, theme: { file: file.name, id, name, mode, variants } };
  } catch (error) {
    return {
      ok: false,
      error: `${file.name}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The look to show: the theme's mode first, then whichever look it has. */
export function externalThemeScheme(
  theme: ExternalTheme,
  system: ColorScheme,
): ColorScheme {
  const wanted = theme.mode === "system" ? system : theme.mode;
  if (theme.variants[wanted]) return wanted;
  return wanted === "dark" ? "light" : "dark";
}

/** Code-block (shiki) colors, read by `createCssVariablesTheme`. */
export const SHIKI_VARIABLE_PREFIX = "--theme-shiki-";

function mix(a: string, percent: number, b: string): string {
  return `color-mix(in srgb, ${a} ${percent}%, ${b})`;
}

/**
 * The `--theme-*` custom properties index.css reads in place of its built-in
 * colors. Every name here is removed again when the theme goes away.
 */
export function externalThemeVariables(
  variant: ExternalThemeVariant,
): Record<string, string> {
  const ui = variant.interface;
  const t = variant.terminal;
  const s = variant.syntax;
  const vars: Record<string, string> = {
    "--theme-background": ui.background,
    "--theme-foreground": ui.foreground,
    "--theme-accent": ui.accent,
    "--theme-link": ui.info,
    "--theme-mention": ui.info,
    "--theme-skill": ui.warning,
    "--theme-heading": s.keyword,
    "--theme-diff-add": ui.success,
    "--theme-diff-add-fg": mix(ui.success, 75, ui.foreground),
    "--theme-diff-del": ui.error,
    "--theme-diff-del-fg": mix(ui.error, 75, ui.foreground),
    "--theme-error": ui.error,
    "--theme-search": ui.search,

    "--theme-syntax-keyword": s.keyword,
    "--theme-syntax-callable": s.function,
    "--theme-syntax-string": s.string,
    "--theme-syntax-type": s.type,
    "--theme-syntax-number": s.number,
    "--theme-syntax-comment": s.comment,
    "--theme-syntax-property": s.property,
    "--theme-syntax-meta": s.attribute,
    "--theme-syntax-invalid": ui.error,

    "--theme-terminal-foreground": t.foreground,
    "--theme-terminal-cursor": t.cursor,
    "--theme-terminal-cursor-text": t.cursorText,
    "--theme-terminal-selection-background": t.selectionBackground,
    "--theme-terminal-selection-foreground": t.selectionForeground,

    [`${SHIKI_VARIABLE_PREFIX}foreground`]: ui.foreground,
    [`${SHIKI_VARIABLE_PREFIX}background`]: "transparent",
    [`${SHIKI_VARIABLE_PREFIX}token-keyword`]: s.keyword,
    [`${SHIKI_VARIABLE_PREFIX}token-string`]: s.string,
    [`${SHIKI_VARIABLE_PREFIX}token-string-expression`]: s.escape,
    [`${SHIKI_VARIABLE_PREFIX}token-comment`]: s.comment,
    [`${SHIKI_VARIABLE_PREFIX}token-constant`]: s.constant,
    [`${SHIKI_VARIABLE_PREFIX}token-function`]: s.function,
    [`${SHIKI_VARIABLE_PREFIX}token-parameter`]: s.parameter,
    [`${SHIKI_VARIABLE_PREFIX}token-punctuation`]: s.punctuation,
    [`${SHIKI_VARIABLE_PREFIX}token-link`]: ui.accent,
    [`${SHIKI_VARIABLE_PREFIX}token-inserted`]: s.added,
    [`${SHIKI_VARIABLE_PREFIX}token-deleted`]: s.removed,
    [`${SHIKI_VARIABLE_PREFIX}token-changed`]: s.changed,
  };
  t.ansi.forEach((value, index) => {
    vars[`--theme-ansi-${index}`] = value;
  });
  return vars;
}

/** Every property `externalThemeVariables` can set. */
export const EXTERNAL_THEME_VARIABLE_NAMES: readonly string[] = Object.keys(
  externalThemeVariables({
    interface: Object.fromEntries(
      INTERFACE_ROLES.map((r) => [r, "#000000"]),
    ) as Record<InterfaceRole, string>,
    terminal: {
      ...(Object.fromEntries(
        TERMINAL_ROLES.map((r) => [r, "#000000"]),
      ) as Record<TerminalRole, string>),
      ansi: Array.from({ length: 16 }, () => "#000000"),
    },
    syntax: Object.fromEntries(
      SYNTAX_ROLES.map((r) => [r, "#000000"]),
    ) as Record<SyntaxRole, string>,
  }),
);

// ---------------------------------------------------------------------------
// State shared by every window through localStorage.

function readCachedFile(): ExternalThemeFile | null {
  try {
    const raw = localStorage.getItem(EXTERNAL_THEME_FILE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) &&
      typeof parsed.name === "string" &&
      typeof parsed.source === "string"
      ? { name: parsed.name, source: parsed.source }
      : null;
  } catch {
    return null;
  }
}

let parsedFrom: string | null = null;
let parsed: ParseResult | null = null;

function currentResult(): ParseResult | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(EXTERNAL_THEME_FILE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== parsedFrom) {
    parsedFrom = raw;
    const file = readCachedFile();
    parsed = file ? parseExternalTheme(file) : null;
  }
  return parsed;
}

/** The selected external theme, or null when the built-in theme applies. */
export function currentExternalTheme(): ExternalTheme | null {
  const result = currentResult();
  return result?.ok ? result.theme : null;
}

let readError: string | null = null;

/** Why the selected theme is not shown, for Settings. */
export function externalThemeError(): string | null {
  if (readError) return readError;
  const result = currentResult();
  return result && !result.ok ? result.error : null;
}

function notifyState() {
  window.dispatchEvent(new Event(EXTERNAL_THEME_STATE_EVENT));
}

export function subscribeExternalTheme(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === EXTERNAL_THEME_FILE_KEY) onChange();
  };
  window.addEventListener(EXTERNAL_THEME_STATE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EXTERNAL_THEME_STATE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Stores what Rust read. Returns whether the stored copy changed. */
function storeFile(file: ExternalThemeFile | null): boolean {
  const next = file ? JSON.stringify(file) : null;
  try {
    if (localStorage.getItem(EXTERNAL_THEME_FILE_KEY) === next) return false;
    if (next == null) localStorage.removeItem(EXTERNAL_THEME_FILE_KEY);
    else localStorage.setItem(EXTERNAL_THEME_FILE_KEY, next);
  } catch {
    return false;
  }
  return true;
}

async function refresh(onChange: () => void) {
  let file: ExternalThemeFile | null = null;
  let error: string | null = null;
  try {
    file =
      (await invoke<ExternalThemeFile | null>("read_external_theme")) ?? null;
  } catch (reason) {
    error = String(reason);
  }
  const errorChanged = error !== readError;
  readError = error;
  // A selection Rust cannot read shows the built-in theme, like no selection.
  const changed = storeFile(error ? null : file);
  if (changed) onChange();
  if (changed || errorChanged) notifyState();
}

/**
 * Reads the selected theme now and again whenever Rust sees its files change.
 * `onChange` applies the theme to this window; other windows hear about it
 * through the storage event.
 */
export function watchExternalTheme(onChange: () => void) {
  void refresh(onChange);
  void listen(EXTERNAL_THEME_CHANGED_EVENT, () => {
    void refresh(onChange);
  }).catch(() => {});
}

/** Settings → "Use Built-in Theme": drops `colorTheme` from appearance.json. */
export async function clearExternalTheme(onChange: () => void) {
  await invoke("clear_external_theme");
  await refresh(onChange);
}
