import { useEffect, useState } from "react";
import { mergeOrderedSubset } from "../../../shared/lib/reorder";
import {
  inboxItemKey,
  type InboxItem,
  type InboxProvider,
} from "./githubTasks";

const KEY = "monocode.inboxFeatured";

type Listener = () => void;

const listeners = new Set<Listener>();

/** Ordered `inboxItemKey`s, first shown on top. */
export function loadInboxFeatured(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const keys = parsed.filter(
      (key): key is string => typeof key === "string" && key.length > 0,
    );
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

export function saveInboxFeatured(keys: readonly string[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(keys));
  } catch {
    return false;
  }
  for (const listener of listeners) listener();
  return true;
}

export function subscribeInboxFeatured(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInboxFeatured(): string[] {
  const [keys, setKeys] = useState(loadInboxFeatured);
  useEffect(
    () => subscribeInboxFeatured(() => setKeys(loadInboxFeatured())),
    [],
  );
  return keys;
}

/** A re-feature lands on top again; the old slot is not remembered. */
export function featureInboxKey(
  keys: readonly string[],
  key: string,
): string[] {
  return [key, ...keys.filter((entry) => entry !== key)];
}

export function unfeatureInboxKeys(
  keys: readonly string[],
  removed: Iterable<string>,
): string[] {
  const drop = new Set(removed);
  return keys.filter((key) => !drop.has(key));
}

/**
 * Undo for a bulk removal: put `restored` back in their `previous` slots
 * while keeping edits made since (new features on top, later unfeatures).
 */
export function restoreFeaturedKeys(
  current: readonly string[],
  previous: readonly string[],
  restored: Iterable<string>,
): string[] {
  const back = new Set(restored);
  const kept = new Set(current);
  const known = new Set(previous);
  return [
    ...current.filter((key) => !known.has(key)),
    ...previous.filter((key) => kept.has(key) || back.has(key)),
  ];
}

/**
 * Only the slots of the dragged subset move. Keys missing from the current
 * list keep their place, so they come back where they were.
 */
export function reorderFeaturedKeys(
  keys: readonly string[],
  orderedSubset: readonly string[],
): string[] {
  return mergeOrderedSubset(
    keys.map((id) => ({ id })),
    orderedSubset.map((id) => ({ id })),
  ).map((entry) => entry.id);
}

export function featuredInboxItems(
  items: readonly InboxItem[],
  keys: readonly string[],
): InboxItem[] {
  const byKey = new Map<string, InboxItem>();
  for (const item of items) {
    const key = inboxItemKey(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return keys.flatMap((key) => byKey.get(key) ?? []);
}

export function featuredKeyProvider(key: string): InboxProvider | null {
  const provider = key.slice(0, key.indexOf(":"));
  return provider === "github" ||
    provider === "linear" ||
    provider === "jira" ||
    provider === "gitlab" ||
    provider === "azuredevops"
    ? provider
    : null;
}

/**
 * Featured keys absent from the list. Only providers whose fetch settled
 * cleanly count: an outage or a disconnect must not look like a vanished item.
 */
export function missingFeaturedKeys(
  keys: readonly string[],
  items: readonly InboxItem[],
  settledProviders: ReadonlySet<InboxProvider>,
): string[] {
  const present = new Set(items.map(inboxItemKey));
  return keys.filter((key) => {
    const provider = featuredKeyProvider(key);
    return !!provider && settledProviders.has(provider) && !present.has(key);
  });
}
