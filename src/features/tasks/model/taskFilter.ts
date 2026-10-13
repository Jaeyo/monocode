import { fuzzyMatch } from "../../../shared/lib/fuzzy";
import { dueState, type Task } from "./tasks";

export type TaskFilter = {
  query: string;
  tag: string | null;
  priority: string | null;
  overdue: boolean;
  links: "any" | "with" | "without";
};

export const EMPTY_TASK_FILTER: TaskFilter = {
  query: "",
  tag: null,
  priority: null,
  overdue: false,
  links: "any",
};

export function isTaskFilterActive(filter: TaskFilter): boolean {
  return (
    filter.query.trim() !== "" ||
    filter.tag !== null ||
    filter.priority !== null ||
    filter.overdue ||
    filter.links !== "any"
  );
}

function textMatches(task: Task, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (fuzzyMatch(needle, task.title)) return true;
  const haystack = [
    task.status,
    task.document,
    ...task.tags,
    ...task.todos.map((todo) => todo.text),
    ...task.links.map((link) => `${link.title} ${link.identifier ?? ""}`),
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Whether a task passes every active part of the filter. */
export function taskMatches(
  task: Task,
  filter: TaskFilter,
  doneColumn: string | null,
  today?: string,
): boolean {
  if (
    filter.tag &&
    !task.tags.some((t) => t.toLowerCase() === filter.tag?.toLowerCase())
  ) {
    return false;
  }
  if (filter.priority && task.priority?.toLowerCase() !== filter.priority) {
    return false;
  }
  if (filter.overdue && dueState(task, doneColumn, today) !== "overdue") {
    return false;
  }
  if (filter.links === "with" && task.links.length === 0) return false;
  if (filter.links === "without" && task.links.length > 0) return false;
  return textMatches(task, filter.query);
}
