import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LAYER } from "../lib/layers";

export type ToastAction = { label: string; run: () => void };

export type Toast = {
  id: number;
  message: string;
  tone?: "info" | "error";
  action?: ToastAction;
};

type ToastOptions = {
  tone?: Toast["tone"];
  action?: ToastAction;
  /** Milliseconds before the toast leaves; 0 keeps it until dismissed. */
  duration?: number;
  /** Runs once when the toast leaves without its action being taken. */
  onExpire?: () => void;
};

const DEFAULT_DURATION = 6000;
let nextId = 1;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const expiries = new Map<number, () => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

/** Shows a short message at the bottom of the window. Returns its id. */
export function showToast(message: string, options: ToastOptions = {}): number {
  const id = nextId++;
  const action = options.action;
  toasts = [
    ...toasts,
    {
      id,
      message,
      tone: options.tone,
      action: action
        ? {
            label: action.label,
            run: () => {
              // Taking the action replaces the expiry callback.
              expiries.delete(id);
              dismissToast(id);
              action.run();
            },
          }
        : undefined,
    },
  ].slice(-4);
  if (options.onExpire) expiries.set(id, options.onExpire);
  const duration = options.duration ?? DEFAULT_DURATION;
  if (duration > 0)
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    );
  emit();
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const expire = expiries.get(id);
  expiries.delete(id);
  const before = toasts.length;
  toasts = toasts.filter((toast) => toast.id !== id);
  if (toasts.length !== before) emit();
  expire?.();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mounted once by the app shell. */
export function ToastHost() {
  const current = useSyncExternalStore(subscribe, () => toasts);
  if (current.length === 0) return null;
  return createPortal(
    <div
      aria-live="polite"
      style={{ zIndex: LAYER.toast }}
      className="pointer-events-none fixed inset-x-0 bottom-4 flex flex-col items-center gap-2 px-3"
    >
      {current.map((toast) => (
        <div
          key={toast.id}
          role={toast.tone === "error" ? "alert" : "status"}
          className="pointer-events-auto flex max-w-[min(480px,calc(100vw-24px))] items-center gap-3 rounded-lg border border-content/10 bg-background-base px-3.5 py-2 text-[12px] text-content shadow-xl"
        >
          <span
            className={`min-w-0 flex-1 ${toast.tone === "error" ? "text-red-400" : ""}`}
          >
            {toast.message}
          </span>
          {toast.action ? (
            <button
              type="button"
              className="shrink-0 rounded-md bg-content/10 px-2 py-0.5 text-[11px] font-medium hover:bg-content/20"
              onClick={toast.action.run}
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-content/40 hover:text-content"
            onClick={() => dismissToast(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
