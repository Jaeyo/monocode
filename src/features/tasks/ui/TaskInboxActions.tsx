import { useMemo, useRef, useState } from "react";
import { CheckList, Plus } from "../../../shared/ui/icons";
import { Popover, type PopoverAnchor } from "../../../shared/ui/Popover";
import { showToast } from "../../../shared/ui/Toasts";
import type { ExplorerMenuItem } from "../../files/ui/ExplorerMenu";
import { inboxItemKey, type InboxItem } from "../../inbox/model/githubTasks";
import type { Task } from "../model/tasks";
import {
  createTask,
  peekTasks,
  updateTask,
  useTasks,
} from "../model/tasksStore";
import { promptForTasksRoot } from "../model/tasksRoot";
import {
  taskLinkFromInboxItem,
  taskLinkKey,
  taskPickerOrder,
  useTasksByInboxKey,
} from "../model/taskInbox";

export type OpenTask = (task: Task) => void;

async function link(task: Task, item: InboxItem): Promise<Task | null> {
  return updateTask(task, {
    type: "addLink",
    link: taskLinkFromInboxItem(item),
  });
}

export async function createTaskForInboxItem(
  item: InboxItem,
  title: string,
  onOpenTask: OpenTask,
): Promise<void> {
  const column = peekTasks().board?.columns[0]?.name;
  if (!column) return;
  const created = await createTask(column, title);
  if (!created) return;
  const linked = (await link(created, item)) ?? created;
  showToast(`Created “${linked.title}” in ${column}.`, {
    action: { label: "Open", run: () => onOpenTask(linked) },
  });
}

export async function addInboxItemToTask(
  task: Task,
  item: InboxItem,
  onOpenTask: OpenTask,
): Promise<void> {
  const linked = await link(task, item);
  if (!linked) return;
  showToast(`Linked to “${linked.title}”.`, {
    action: { label: "Open", run: () => onOpenTask(linked) },
  });
}

export function removeInboxItemFromTask(task: Task, item: InboxItem): void {
  const key = inboxItemKey(item);
  const linked = task.links.find((entry) => taskLinkKey(entry) === key);
  if (linked) void updateTask(task, { type: "removeLink", url: linked.url });
}

// ---- context menu ---------------------------------------------------------

export function inboxTaskMenuItems(tasks: readonly Task[]): ExplorerMenuItem[] {
  const items: ExplorerMenuItem[] = [
    { kind: "sep" },
    { kind: "item", id: "task:create", label: "Create Task…" },
    { kind: "item", id: "task:add", label: "Add to Task…" },
  ];
  if (tasks.length === 1) {
    items.push(
      {
        kind: "item",
        id: `task:open:${tasks[0].id}`,
        label: `Open Task: ${tasks[0].title}`,
      },
      {
        kind: "item",
        id: `task:remove:${tasks[0].id}`,
        label: `Remove from Task: ${tasks[0].title}`,
      },
    );
  } else if (tasks.length > 1) {
    items.push(
      {
        kind: "item",
        id: "task:open",
        label: "Open Task",
        submenu: tasks.map((task) => ({
          kind: "item" as const,
          id: `task:open:${task.id}`,
          label: task.title,
        })),
      },
      {
        kind: "item",
        id: "task:remove",
        label: "Remove from Task",
        submenu: tasks.map((task) => ({
          kind: "item" as const,
          id: `task:remove:${task.id}`,
          label: task.title,
        })),
      },
    );
  }
  return items;
}

/**
 * Handles a `task:*` menu id. Returns the popover to open for create/add, or
 * null when the action is already done (or the id is not a task action).
 */
export function pickInboxTaskMenu(
  id: string,
  item: InboxItem,
  tasks: readonly Task[],
  onOpenTask: OpenTask,
): "create" | "add" | null {
  if (id === "task:create") return "create";
  if (id === "task:add") return "add";
  const open = /^task:open:(.+)$/.exec(id);
  if (open) {
    const task = tasks.find((entry) => entry.id === open[1]);
    if (task) onOpenTask(task);
    return null;
  }
  const remove = /^task:remove:(.+)$/.exec(id);
  if (remove) {
    const task = tasks.find((entry) => entry.id === remove[1]);
    if (task) removeInboxItemFromTask(task, item);
  }
  return null;
}

// ---- popover ----------------------------------------------------------------

export function InboxTaskPopover({
  anchor,
  item,
  mode: initialMode,
  onClose,
  onOpenTask,
}: {
  anchor: PopoverAnchor;
  item: InboxItem;
  mode: "create" | "add";
  onClose: () => void;
  onOpenTask: OpenTask;
}) {
  const tasks = useTasks();
  const [mode, setMode] = useState(initialMode);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [includeDone, setIncludeDone] = useState(false);
  const linkedIds = new Set(
    (useTasksByInboxKey().get(inboxItemKey(item)) ?? []).map((task) => task.id),
  );
  const candidates = useMemo(
    () => taskPickerOrder(tasks.board, query, includeDone).slice(0, 50),
    [tasks.board, query, includeDone],
  );
  const busy = useRef(false);

  const body = () => {
    if (tasks.status === "unconfigured" || tasks.status === "missing") {
      return (
        <div className="flex flex-col gap-2 p-2 text-[12px]">
          <p className="text-content/70">
            {tasks.status === "missing"
              ? "The tasks folder cannot be found."
              : "Tasks are not set up yet. Choose a folder to keep them in."}
          </p>
          <button
            type="button"
            onClick={() => {
              onClose();
              void promptForTasksRoot();
            }}
            className="self-start rounded-md bg-content px-2.5 py-1 text-[12px] font-medium text-background-base hover:bg-content/80"
          >
            Choose folder…
          </button>
        </div>
      );
    }
    if (mode === "create") {
      const submit = async () => {
        const value = title.trim();
        if (!value || busy.current) return;
        busy.current = true;
        onClose();
        await createTaskForInboxItem(item, value, onOpenTask);
      };
      return (
        <form
          className="flex flex-col gap-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <span className="text-[11px] text-content/50">
            New task in {tasks.board?.columns[0]?.name ?? "the first column"}
          </span>
          <input
            autoFocus
            value={title}
            aria-label="Task title"
            placeholder="Task title"
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-content/10 px-2.5 py-0.5 text-[12px] text-content/70 hover:bg-content/20"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="rounded-md bg-content px-2.5 py-0.5 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-30"
            >
              Create
            </button>
          </div>
        </form>
      );
    }
    return (
      <div className="flex flex-col gap-1 p-1">
        <input
          autoFocus
          value={query}
          aria-label="Find a task"
          placeholder="Find a task"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && candidates[0]) {
              event.preventDefault();
              onClose();
              void addInboxItemToTask(candidates[0], item, onOpenTask);
            }
          }}
          className="m-1 rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content outline-none focus:border-accent"
        />
        <div
          role="listbox"
          aria-label="Tasks"
          className="max-h-64 overflow-y-auto"
        >
          {candidates.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-content/40">
              No tasks found.
            </p>
          ) : (
            candidates.map((task) => {
              const already = linkedIds.has(task.id);
              return (
                <button
                  key={task.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={already}
                  onClick={() => {
                    onClose();
                    void addInboxItemToTask(task, item, onOpenTask);
                  }}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-content/80 hover:bg-content/5 disabled:opacity-40"
                >
                  <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  <span className="shrink-0 text-[11px] text-content/40">
                    {already ? "Linked" : task.column}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center justify-between border-t border-content/10 px-1 pt-1">
          <label className="flex items-center gap-1.5 px-1 text-[11px] text-content/50">
            <input
              type="checkbox"
              checked={includeDone}
              onChange={(event) => setIncludeDone(event.target.checked)}
            />
            Include {tasks.board?.doneColumn ?? "done"}
          </label>
          <button
            type="button"
            onClick={() => setMode("create")}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-content/60 hover:bg-content/5 hover:text-content"
          >
            <Plus className="size-3" strokeWidth={1.75} />
            New task
          </button>
        </div>
      </div>
    );
  };

  return (
    <Popover
      anchor={anchor}
      width={300}
      role="dialog"
      aria-label={mode === "create" ? "Create task" : "Add to task"}
      onDismiss={onClose}
    >
      {body()}
    </Popover>
  );
}

// ---- chips --------------------------------------------------------------------

/** On an Inbox card: which tasks the item belongs to. Display only. */
export function InboxTaskBadge({
  tasks,
  doneColumn,
}: {
  tasks: readonly Task[];
  doneColumn: string | null;
}) {
  if (tasks.length === 0) return null;
  const allDone = tasks.every((task) => task.column === doneColumn);
  const label = tasks.length === 1 ? tasks[0].title : `${tasks.length}`;
  return (
    <span
      title={`Tasks: ${tasks.map((task) => task.title).join(", ")}`}
      className={`inline-flex min-w-0 max-w-[10rem] items-center gap-0.5 text-[11px] ${
        allDone ? "text-content/30" : "text-content/55"
      }`}
    >
      <CheckList className="size-3 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

/** In the Inbox detail header: linked tasks to open, and the add button. */
export function InboxTaskControls({
  item,
  onOpenTask,
  className,
}: {
  item: InboxItem;
  onOpenTask: OpenTask;
  className: string;
}) {
  const tasks = useTasksByInboxKey().get(inboxItemKey(item)) ?? [];
  const { board } = useTasks();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          title={`Open task in ${task.column}`}
          onClick={() => onOpenTask(task)}
          className={`${className} max-w-[14rem] ${
            task.column === board?.doneColumn ? "opacity-60" : ""
          }`}
        >
          <CheckList className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{task.title}</span>
        </button>
      ))}
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(true)}
        className={className}
      >
        <CheckList className="size-3.5" strokeWidth={1.75} />
        {tasks.length ? "Add to another Task" : "Add to Task"}
      </button>
      {open ? (
        <InboxTaskPopover
          anchor={button}
          item={item}
          mode="add"
          onClose={() => setOpen(false)}
          onOpenTask={onOpenTask}
        />
      ) : null}
    </>
  );
}
