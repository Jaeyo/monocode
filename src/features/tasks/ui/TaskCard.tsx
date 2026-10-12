import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Check, CircleAlert } from "../../../shared/ui/icons";
import { InboxProviderMark } from "../../inbox/ui/InboxProviderMark";
import type { InboxProvider } from "../../inbox/model/githubTasks";
import {
  dueState,
  todoProgress,
  type Task,
  type TaskLink,
} from "../model/tasks";
import { updateTask } from "../model/tasksStore";

const PROVIDERS = new Set<string>([
  "github",
  "gitlab",
  "linear",
  "jira",
  "azuredevops",
]);

export function linkLabel(link: TaskLink): string {
  const ref =
    link.identifier ??
    (link.number != null
      ? `${link.repo ? `${link.repo}` : ""}#${link.number}`
      : link.repo);
  return link.title ? `${ref ? `${ref} ` : ""}${link.title}` : ref || link.url;
}

export function TaskLinkChip({
  link,
  onOpen,
}: {
  link: TaskLink;
  onOpen?: (link: TaskLink) => void;
}) {
  return (
    <button
      type="button"
      data-no-drag
      title={link.url}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(link);
      }}
      className="flex min-w-0 max-w-full items-center gap-1 rounded px-1 py-px text-[11px] text-content/60 hover:bg-content/10 hover:text-content"
    >
      {PROVIDERS.has(link.provider) ? (
        <InboxProviderMark
          provider={link.provider as InboxProvider}
          className="size-3 shrink-0"
        />
      ) : null}
      <span className="min-w-0 truncate">{linkLabel(link)}</span>
    </button>
  );
}

const PRIORITY_MARK: Record<string, string> = {
  high: "text-red-400",
  medium: "text-amber-400",
  low: "text-content/40",
};

export function PriorityMark({ priority }: { priority: string | null }) {
  if (!priority) return null;
  const known = PRIORITY_MARK[priority.toLowerCase()];
  if (!known) {
    return (
      <span className="shrink-0 rounded bg-content/10 px-1 text-[10px] text-content/60">
        {priority}
      </span>
    );
  }
  return (
    <span
      title={`Priority: ${priority}`}
      aria-label={`Priority ${priority}`}
      className={`shrink-0 text-[11px] font-semibold leading-none ${known}`}
    >
      {priority.toLowerCase() === "high"
        ? "!!!"
        : priority.toLowerCase() === "medium"
          ? "!!"
          : "!"}
    </span>
  );
}

/** `Oct 20`, with the year when it is not this year. */
export function dueLabel(due: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!match) return due;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function DueChip({
  task,
  doneColumn,
}: {
  task: Task;
  doneColumn: string | null;
}) {
  if (!task.due) return null;
  const state = dueState(task, doneColumn);
  const label = dueLabel(task.due);
  const tone =
    state === "overdue"
      ? "bg-red-500/15 text-red-400"
      : state === "today"
        ? "bg-amber-500/15 text-amber-400"
        : "bg-content/10 text-content/55";
  return (
    <span
      title={
        state === "overdue"
          ? `Overdue — due ${task.due}`
          : state === "today"
            ? "Due today"
            : `Due ${task.due}`
      }
      className={`shrink-0 rounded px-1 py-px text-[10px] tabular-nums ${tone}`}
    >
      {label}
    </span>
  );
}

type Props = {
  task: Task;
  doneColumn: string | null;
  selected: boolean;
  dragging: boolean;
  setRef: (el: HTMLElement | null) => void;
  onSelect: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onOpenLink: (link: TaskLink) => void;
};

export function TaskCard({
  task,
  doneColumn,
  selected,
  dragging,
  setRef,
  onSelect,
  onPointerDown,
  onContextMenu,
  onOpenLink,
}: Props) {
  const progress = todoProgress(task);
  return (
    <div
      ref={setRef}
      role="listitem"
      aria-current={selected ? "true" : undefined}
      data-task-id={task.id}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      className={`group flex select-none flex-col gap-1 rounded-md border px-2.5 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        selected
          ? "border-transparent bg-selection"
          : "border-transparent hover:bg-content/5"
      } ${dragging ? "opacity-40" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <PriorityMark priority={task.priority} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-content">
          {task.title}
        </span>
        {task.readOnly || task.duplicate ? (
          <span
            title={
              task.readOnly
                ? `Read-only: ${task.error ?? "this file cannot be parsed"}`
                : "This file shares its id with another task; it gets a new id when edited."
            }
          >
            <CircleAlert
              className="size-3.5 shrink-0 text-amber-400"
              strokeWidth={1.75}
            />
          </span>
        ) : null}
        {progress.total > 0 ? (
          <span
            className="shrink-0 text-[11px] tabular-nums text-content/45"
            title={`${progress.done} of ${progress.total} todos done`}
          >
            {progress.done}/{progress.total}
          </span>
        ) : null}
        <DueChip task={task} doneColumn={doneColumn} />
      </div>
      {task.links.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-x-1">
          {task.links.map((link) => (
            <TaskLinkChip key={link.url} link={link} onOpen={onOpenLink} />
          ))}
        </div>
      ) : null}
      {task.status ? (
        <div className="truncate text-[11px] text-content/50">
          {task.status}
        </div>
      ) : null}
      {task.todos.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pt-0.5">
          {task.todos.map((todo, index) => (
            <li
              key={`${index}:${todo.text}`}
              className="flex min-w-0 items-start gap-1.5"
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={todo.done}
                aria-label={todo.text}
                data-no-drag
                disabled={task.readOnly}
                onClick={(event) => {
                  event.stopPropagation();
                  void updateTask(task, {
                    type: "toggleTodo",
                    index,
                    text: todo.text,
                    done: !todo.done,
                  });
                }}
                className={`mt-[3px] grid size-3 shrink-0 place-items-center rounded-[3px] border disabled:opacity-40 ${
                  todo.done
                    ? "border-accent bg-accent text-white"
                    : "border-content/30 hover:border-content/60"
                }`}
              >
                {todo.done ? (
                  <Check className="size-2.5" strokeWidth={3} />
                ) : null}
              </button>
              <span
                className={`min-w-0 flex-1 text-[12px] leading-snug ${
                  todo.done ? "text-content/40 line-through" : "text-content/75"
                }`}
              >
                {todo.text}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
