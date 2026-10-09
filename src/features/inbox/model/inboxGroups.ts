import {
  inboxItemKey,
  sortInboxItems,
  type InboxItem,
  type InboxProvider,
} from "./githubTasks";

/** Groups whose items carry no container land here, always last. */
export const INBOX_OTHER_GROUP = "~other";

export type InboxGroup = {
  /** `${provider}:${container}` — stable across refreshes, used for collapse state. */
  id: string;
  label: string;
  provider: InboxProvider;
  items: InboxItem[];
};

export type InboxListRow =
  | { type: "group"; group: InboxGroup; collapsed: boolean; unseen: number }
  | { type: "item"; item: InboxItem; key: string };

/**
 * The container an item lives in: the repository for code hosts, the project
 * key for Jira, the team for Linear. Linear keys on the id because team names
 * can be renamed; Jira keys are stable enough and match what the card shows.
 */
export function inboxGroupContainer(item: InboxItem): string {
  if (item.provider === "linear") return item.teamId || "";
  return item.repo || "";
}

export function inboxGroupId(item: InboxItem): string {
  return `${item.provider}:${inboxGroupContainer(item) || INBOX_OTHER_GROUP}`;
}

function inboxGroupLabel(item: InboxItem): string {
  if (!inboxGroupContainer(item)) return "Other";
  if (item.provider === "linear") return item.teamName || item.teamId || "";
  if (item.provider === "jira") {
    return item.teamName && item.teamName !== item.repo
      ? `${item.repo} · ${item.teamName}`
      : item.repo;
  }
  return item.repo;
}

/**
 * Most recently active container first; "Other" sinks to the bottom. Items keep
 * the inbox's usual recency order inside their group.
 */
export function groupInboxItems(items: InboxItem[]): InboxGroup[] {
  const groups = new Map<string, InboxGroup>();
  for (const item of sortInboxItems(items)) {
    const id = inboxGroupId(item);
    const group = groups.get(id);
    if (group) group.items.push(item);
    else {
      groups.set(id, {
        id,
        label: inboxGroupLabel(item),
        provider: item.provider,
        items: [item],
      });
    }
  }
  // Insertion order already follows each group's newest item.
  const ordered = [...groups.values()];
  const other = ordered.filter((group) => isOtherGroup(group));
  return [...ordered.filter((group) => !isOtherGroup(group)), ...other];
}

function isOtherGroup(group: InboxGroup): boolean {
  return group.id.endsWith(`:${INBOX_OTHER_GROUP}`);
}

/**
 * Flattens groups into list rows. Groups start collapsed, so an Inbox over
 * many repositories opens as a short list of headers; `expanded` holds the
 * ones the user opened. A single group renders flat — a lone header says
 * nothing. `expandAll` and `expandedIds` open groups (search, a targeted
 * item) without touching the saved state.
 */
export function inboxListRows(
  items: InboxItem[],
  {
    grouped,
    expanded,
    expandAll = false,
    expandedIds = [],
    isUnseen,
  }: {
    grouped: boolean;
    expanded: ReadonlySet<string>;
    expandAll?: boolean;
    expandedIds?: readonly string[];
    isUnseen: (item: InboxItem) => boolean;
  },
): InboxListRow[] {
  const itemRow = (item: InboxItem): InboxListRow => ({
    type: "item",
    item,
    key: inboxItemKey(item),
  });
  if (!grouped) return items.map(itemRow);
  const groups = groupInboxItems(items);
  if (groups.length <= 1) return (groups[0]?.items ?? []).map(itemRow);
  const forced = new Set(expandedIds);
  const rows: InboxListRow[] = [];
  for (const group of groups) {
    const isCollapsed =
      !expandAll && !forced.has(group.id) && !expanded.has(group.id);
    rows.push({
      type: "group",
      group,
      collapsed: isCollapsed,
      unseen: group.items.filter(isUnseen).length,
    });
    if (!isCollapsed) rows.push(...group.items.map(itemRow));
  }
  return rows;
}

const EXPANDED_KEY = "monocode.inboxExpandedGroups";
/** Collapse state from before groups started collapsed; no longer read. */
const LEGACY_COLLAPSED_KEY = "monocode.inboxCollapsedGroups";

export function loadInboxExpandedGroups(): Set<string> {
  try {
    localStorage.removeItem(LEGACY_COLLAPSED_KEY);
    const raw = localStorage.getItem(EXPANDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [],
    );
  } catch {
    return new Set();
  }
}

export function saveInboxExpandedGroups(ids: ReadonlySet<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    // private mode / quota
  }
}
