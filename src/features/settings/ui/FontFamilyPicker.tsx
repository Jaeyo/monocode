import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, ChevronDown, Search } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import {
  fontFamilyCss,
  isGenericFamily,
  loadSystemFonts,
  primaryFontFamily,
  type FontTarget,
  type SystemFontFamily,
} from "../model/fonts";

export type SystemFontsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; fonts: SystemFontFamily[] }
  | { status: "error" };

/**
 * Installed families, fetched the first time `wanted` turns true (the picker
 * opened, or a saved font needs its installed check) and shared from then on
 * through loadSystemFonts' per-window cache.
 */
export function useSystemFonts(wanted: boolean): SystemFontsState {
  const [state, setState] = useState<SystemFontsState>({ status: "idle" });
  // Once per mount; `wanted` only ever has to flip on. Kept out of state so
  // marking the request does not re-run (and cancel) the effect that made it.
  const requested = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!wanted || requested.current) return;
    requested.current = true;
    setState({ status: "loading" });
    loadSystemFonts().then(
      (fonts) => {
        if (mounted.current) setState({ status: "ready", fonts });
      },
      () => {
        if (mounted.current) setState({ status: "error" });
      },
    );
  }, [wanted]);
  return state;
}

/**
 * True when a saved family is known to be missing: the list loaded, it is
 * not a CSS generic, and no installed family matches its first name. Unknown
 * (still loading, failed, browser dev with no list) is never "missing".
 */
export function isFontMissing(value: string, fonts: SystemFontsState): boolean {
  const name = primaryFontFamily(value);
  if (!name || isGenericFamily(name)) return false;
  if (fonts.status !== "ready" || fonts.fonts.length === 0) return false;
  const lower = name.toLowerCase();
  return !fonts.fonts.some((font) => font.family.toLowerCase() === lower);
}

type Choice =
  | { kind: "default" }
  | { kind: "custom"; value: string }
  | { kind: "font"; family: string; monospace: boolean };

function choiceValue(choice: Choice): string {
  if (choice.kind === "default") return "";
  return choice.kind === "custom" ? choice.value : choice.family;
}

function choiceKey(choice: Choice): string {
  return `${choice.kind}:${choiceValue(choice)}`;
}

/**
 * Searchable list of installed families that also takes any typed name or
 * comma-separated stack. Each family previews in its own face; code and
 * terminal pickers start filtered to fixed-pitch families.
 */
export function FontFamilyPicker({
  label,
  target,
  value,
  onChange,
  fonts,
  onWantFonts,
}: {
  label: string;
  target: FontTarget;
  value: string;
  onChange: (value: string) => void;
  fonts: SystemFontsState;
  onWantFonts: () => void;
}) {
  const monoTarget = target !== "interface";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [monoOnly, setMonoOnly] = useState(monoTarget);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const activeOption = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const current = value.trim();
  const trimmedQuery = query.trim();
  const needle = trimmedQuery.toLocaleLowerCase();

  const choices = useMemo<Choice[]>(() => {
    const installed = fonts.status === "ready" ? fonts.fonts : [];
    const matches = installed.filter(
      (font) =>
        (!monoOnly || font.monospace) &&
        (!needle || font.family.toLocaleLowerCase().includes(needle)),
    );
    const exact = installed.some(
      (font) => font.family.toLocaleLowerCase() === needle,
    );
    const out: Choice[] = [];
    if (!needle) out.push({ kind: "default" });
    if (trimmedQuery && !exact) {
      out.push({ kind: "custom", value: trimmedQuery });
    }
    for (const font of matches) {
      out.push({
        kind: "font",
        family: font.family,
        monospace: font.monospace,
      });
    }
    return out;
  }, [fonts, monoOnly, needle, trimmedQuery]);

  const activeId =
    choices[active] != null ? `${listId}-option-${active}` : undefined;

  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  const openMenu = () => {
    onWantFonts();
    setQuery("");
    setMonoOnly(monoTarget);
    setActive(0);
    setOpen(true);
  };

  const pick = (choice: Choice) => {
    onChange(choiceValue(choice));
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      search.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Start on the saved choice once the list is in, so Enter keeps it.
  useEffect(() => {
    if (!open || needle) return;
    const index = choices.findIndex((choice) =>
      choice.kind === "default"
        ? current === ""
        : choiceValue(choice).toLowerCase() === current.toLowerCase(),
    );
    setActive(Math.max(0, index));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fonts.status, monoOnly]);

  useEffect(() => {
    setActive((index) =>
      choices.length === 0 ? 0 : Math.min(index, choices.length - 1),
    );
  }, [choices.length]);

  useLayoutEffect(() => {
    if (!open) return;
    const container = list.current;
    const item = activeOption.current;
    if (!container || !item) return;
    const bounds = container.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < bounds.top) container.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) {
      container.scrollTop += row.bottom - bounds.bottom;
    }
  }, [active, open]);

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(choices.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices[active];
      if (choice) pick(choice);
    }
  };

  const triggerFont = fontFamilyCss(current, target) ?? undefined;

  return (
    <div ref={root} className="relative inline-flex w-56 max-w-full">
      <button
        ref={trigger}
        type="button"
        aria-label={`${label}: ${current || "Default"}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp"))
            return;
          event.preventDefault();
          openMenu();
        }}
        className="flex h-7 w-full items-center justify-between gap-2 rounded-md border border-content/10 bg-content/5 px-2 text-left text-[12px] text-content outline-none hover:border-content/20 focus-visible:border-content/25"
      >
        <span
          className={`min-w-0 flex-1 truncate ${current ? "" : "text-content/60"}`}
          style={{ fontFamily: triggerFont }}
        >
          {current || "Default"}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-content/50 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <Popover
          anchor={root}
          side="bottom"
          align="end"
          gap={4}
          width={300}
          maxHeight={320}
          role="dialog"
          aria-label={`${label} options`}
          onDismiss={(reason) => close(reason === "escape")}
          className="flex flex-col overflow-hidden"
        >
          <label className="flex h-8 shrink-0 items-center gap-2 border-b border-stroke px-2.5 text-content/45 focus-within:text-content/70">
            <Search className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="sr-only">Search or type a font name</span>
            <input
              ref={search}
              role="combobox"
              aria-label="Search or type a font name"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeId}
              value={query}
              placeholder="Search or type a font name…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKeyDown}
              className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/35"
            />
          </label>
          {monoTarget ? (
            <label className="flex h-7 shrink-0 cursor-pointer items-center gap-2 border-b border-stroke px-2.5 text-[11px] text-content/55 select-none">
              <input
                type="checkbox"
                checked={monoOnly}
                onChange={(event) => {
                  setMonoOnly(event.target.checked);
                  search.current?.focus({ preventScroll: true });
                }}
                className="accent-accent"
              />
              Monospace only
            </label>
          ) : null}
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            className="min-h-0 flex-1 overflow-y-auto overscroll-none p-1 outline-none"
          >
            {choices.map((choice, index) => {
              const highlighted = index === active;
              const selected =
                choice.kind === "default"
                  ? current === ""
                  : choice.kind === "font" &&
                    choice.family.toLowerCase() === current.toLowerCase();
              const text =
                choice.kind === "default"
                  ? "Default"
                  : choice.kind === "custom"
                    ? `Use “${choice.value}”`
                    : choice.family;
              const previewFont =
                choice.kind === "font"
                  ? (fontFamilyCss(choice.family, target) ?? undefined)
                  : undefined;
              return (
                <button
                  key={choiceKey(choice)}
                  ref={highlighted ? activeOption : undefined}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(choice)}
                  // Off-screen rows skip layout, so opening the list does not
                  // load every installed face at once.
                  className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] leading-none [contain-intrinsic-size:auto_28px] [content-visibility:auto] ${
                    highlighted
                      ? "bg-selection text-content"
                      : "text-content/75 hover:bg-content/5 hover:text-content"
                  }`}
                >
                  <span className="grid size-3.5 shrink-0 place-items-center">
                    {selected ? (
                      <Check className="size-3" strokeWidth={2} />
                    ) : null}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate ${choice.kind === "font" ? "" : "text-content/60"}`}
                    style={{ fontFamily: previewFont }}
                  >
                    {text}
                  </span>
                </button>
              );
            })}
            <FontListStatus
              fonts={fonts}
              empty={choices.every((choice) => choice.kind !== "font")}
              filtered={!!needle || monoOnly}
            />
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function FontListStatus({
  fonts,
  empty,
  filtered,
}: {
  fonts: SystemFontsState;
  empty: boolean;
  filtered: boolean;
}) {
  let message: string | null = null;
  if (fonts.status === "error") {
    message = "Couldn't read installed fonts. Type a font name instead.";
  } else if (fonts.status !== "ready") {
    message = "Loading installed fonts…";
  } else if (fonts.fonts.length === 0) {
    message = "Type a font name or a comma-separated stack.";
  } else if (empty && filtered) {
    message = "No matching installed fonts.";
  }
  if (!message) return null;
  return (
    <p className="px-2 py-3 text-center text-[12px] text-content/45">
      {message}
    </p>
  );
}
