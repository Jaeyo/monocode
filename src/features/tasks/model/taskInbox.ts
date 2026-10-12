import { useMemo } from "react";
import {
  inboxIdentityKey,
  type InboxItem,
  type InboxKind,
  type InboxProvider,
} from "../../inbox/model/githubTasks";
import { allTasks, type Task, type TaskBoard, type TaskLink } from "./tasks";
import { useTasks } from "./tasksStore";

/** The link a task stores for an Inbox item: enough to find the item again. */
export function taskLinkFromInboxItem(item: InboxItem): TaskLink {
  return {
    provider: item.provider,
    repo: item.repo,
    kind: item.kind,
    number: item.number,
    url: item.url,
    title: item.title,
    ...(item.identifier ? { identifier: item.identifier } : {}),
    ...(item.id ? { id: item.id } : {}),
    ...(item.projectPath ? { projectPath: item.projectPath } : {}),
  };
}

/** Same key `inboxItemKey` gives the item, so links and items meet. */
export function taskLinkKey(link: TaskLink): string {
  return `${link.provider}:${inboxIdentityKey({
    provider: link.provider as InboxProvider,
    kind: link.kind as InboxKind,
    number: link.number ?? 0,
    repo: link.repo,
    url: link.url,
    identifier: link.identifier,
    id: link.id,
  })}`;
}

/** Tasks per linked Inbox item key, in board order. */
export function tasksByInboxKey(board: TaskBoard | null): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of allTasks(board)) {
    for (const link of task.links) {
      const key = taskLinkKey(link);
      const tasks = map.get(key);
      if (!tasks) map.set(key, [task]);
      else if (!tasks.includes(task)) tasks.push(task);
    }
  }
  return map;
}

export function useTasksByInboxKey(): Map<string, Task[]> {
  const { board } = useTasks();
  return useMemo(() => tasksByInboxKey(board), [board]);
}

/** Tasks to offer when adding an item: recently edited first, done last. */
export function taskPickerOrder(
  board: TaskBoard | null,
  query: string,
  includeDone: boolean,
): Task[] {
  const needle = query.trim().toLowerCase();
  return allTasks(board)
    .filter((task) => !task.readOnly)
    .filter((task) => includeDone || task.column !== board?.doneColumn)
    .filter(
      (task) =>
        !needle ||
        task.title.toLowerCase().includes(needle) ||
        task.status.toLowerCase().includes(needle),
    )
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}
