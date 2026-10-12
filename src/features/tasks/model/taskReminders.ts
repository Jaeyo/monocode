import { invoke } from "@tauri-apps/api/core";
import { useMemo, useSyncExternalStore } from "react";
import { loadSoundsEnabled } from "../../settings/model/sounds";
import { readFlag, writeFlag } from "../../settings/model/storageFlags";
import { allTasks, dueState, localDateKey, type TaskBoard } from "./tasks";
import { useTasks } from "./tasksStore";

/** Stands in for a session id, so a click opens Tasks instead. */
export const TASKS_DUE_NOTIFICATION_ID = "monocode-tasks-due";

const ENABLED_KEY = "monocode.tasksDueReminders";
const LAST_KEY = "monocode.tasksDueRemindedOn";
const CHANGE_EVENT = "monocode:tasks-due-reminders-change";
/** The daily reminder waits for the working day to start. */
const REMIND_FROM_HOUR = 9;

export function loadDueRemindersEnabled(): boolean {
  return readFlag(ENABLED_KEY) ?? true;
}

export function saveDueRemindersEnabled(enabled: boolean): void {
  writeFlag(ENABLED_KEY, enabled);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeDueReminders(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

export function dueCounts(
  board: TaskBoard | null,
  today: string = localDateKey(),
): { today: number; overdue: number } {
  let dueToday = 0;
  let overdue = 0;
  for (const task of allTasks(board)) {
    const state = dueState(task, board?.doneColumn ?? null, today);
    if (state === "today") dueToday++;
    else if (state === "overdue") overdue++;
  }
  return { today: dueToday, overdue };
}

/** Overdue tasks, for the sidebar badge. */
export function useOverdueTaskCount(): number {
  const { board } = useTasks();
  return useMemo(() => dueCounts(board).overdue, [board]);
}

export function useDueRemindersEnabled(): boolean {
  return useSyncExternalStore(
    subscribeDueReminders,
    loadDueRemindersEnabled,
    () => true,
  );
}

export function dueReminderText(counts: {
  today: number;
  overdue: number;
}): string {
  const parts: string[] = [];
  if (counts.today) {
    parts.push(
      `${counts.today} ${counts.today === 1 ? "task is" : "tasks are"} due today`,
    );
  }
  if (counts.overdue) parts.push(`${counts.overdue} overdue`);
  return parts.join(", ");
}

/**
 * Sends at most one bundled reminder a day, from 9:00 local time, for tasks
 * due today or overdue. Returns whether one was sent.
 */
export async function maybeRemindDue(
  board: TaskBoard | null,
  now: Date = new Date(),
): Promise<boolean> {
  if (!board || !loadDueRemindersEnabled()) return false;
  if (now.getHours() < REMIND_FROM_HOUR) return false;
  const today = localDateKey(now);
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {
    // Without storage the reminder may repeat; that beats never showing it.
  }
  if (last === today) return false;
  const counts = dueCounts(board, today);
  if (counts.today === 0 && counts.overdue === 0) return false;
  try {
    localStorage.setItem(LAST_KEY, today);
  } catch {
    // See above.
  }
  try {
    await invoke("show_notification", {
      sessionId: TASKS_DUE_NOTIFICATION_ID,
      title: "Tasks",
      subtitle: "",
      body: dueReminderText(counts),
      sound: loadSoundsEnabled(),
    });
    return true;
  } catch {
    return false;
  }
}
