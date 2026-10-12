import { useEffect, useRef, useState } from "react";

/**
 * A one-line field that commits on Enter and cancels on Escape. Blur commits
 * a non-empty value when `commitOnBlur`, and cancels otherwise.
 */
export function InlineInput({
  initial = "",
  placeholder,
  ariaLabel,
  commitOnBlur = false,
  className,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  ariaLabel: string;
  commitOnBlur?: boolean;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const trimmed = value.trim();
    if (commit && trimmed) onCommit(trimmed);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-no-drag
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(commitOnBlur)}
      className={`min-w-0 rounded border border-content/15 bg-transparent px-1.5 py-0.5 text-[12px] text-content outline-none focus:border-accent ${className ?? ""}`}
    />
  );
}
