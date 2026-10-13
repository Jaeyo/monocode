import { useEffect, useMemo, useRef, useState } from "react";
import { CheckList, Plus, RefreshCw } from "../../../shared/ui/icons";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { allTasks, type Task } from "../model/tasks";
import { peekTasks, refreshTasks, useTasks } from "../model/tasksStore";
import { refreshLinkStatuses } from "../model/taskLinkStatus";
import { promptForTasksRoot } from "../model/tasksRoot";
import { takeTaskUndo } from "../model/taskActions";
import {
  TASK_FILTER_EVENT,
  TASK_SELECT_EVENT,
  takeOverdueFilter,
  takeTaskSelection,
} from "../model/taskViewState";
import {
  EMPTY_TASK_FILTER,
  isTaskFilterActive,
  taskMatches,
  type TaskFilter,
} from "../model/taskFilter";
import { TaskFilterBar } from "./TaskFilterBar";
import { TaskBoardList } from "./TaskBoardList";
import { TaskDetail } from "./TaskDetail";
import { TaskSessionsField } from "./TaskSessionsField";
import type { RecentProject } from "../../projects/model/recents";
import type { SessionSummary } from "../../sessions/data/sessionStore";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  recents?: RecentProject[];
  /** The project a task's session starts in when it names none. */
  defaultCwd?: string;
  sessions?: readonly SessionSummary[];
  onOpenSession?: (sessionId: string) => void;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

const NO_RECENTS: RecentProject[] = [];
const NO_SESSIONS: readonly SessionSummary[] = [];

// Kept across visits, like the Notes selection.
type Selection = Pick<Task, "id" | "path">;
let rememberedSelection: Selection | null = null;
let rememberedFilter: TaskFilter = EMPTY_TASK_FILTER;

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest("input, textarea, select, [contenteditable='true']") !==
        null)
  );
}

/** A menu or dialog that should take Escape before the view does. */
function overlayOpen(): boolean {
  return (
    document.querySelector(
      "[role='menu'], [role='dialog'], [data-dialog-popover]",
    ) !== null
  );
}

export function TasksView({
  besideRail = false,
  compactRail = false,
  recents = NO_RECENTS,
  defaultCwd,
  sessions = NO_SESSIONS,
  onOpenSession,
  onClose,
  onToggleSidebar,
}: Props) {
  const tasks = useTasks();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [refreshing, setRefreshing] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(
    () => takeTaskSelection() ?? rememberedSelection,
  );
  const [creatingIn, setCreatingIn] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>(() =>
    takeOverdueFilter()
      ? { ...rememberedFilter, overdue: true }
      : rememberedFilter,
  );
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rememberedFilter = filter;
  }, [filter]);

  // A due reminder asked for the overdue tasks.
  useEffect(() => {
    const onFilter = () => {
      if (takeOverdueFilter()) {
        setFilter((current) => ({ ...current, overdue: true }));
      }
    };
    window.addEventListener(TASK_FILTER_EVENT, onFilter);
    return () => window.removeEventListener(TASK_FILTER_EVENT, onFilter);
  }, []);

  // Another view (Inbox, a session chip) asked to show a task.
  useEffect(() => {
    const onSelect = () => {
      const next = takeTaskSelection();
      if (next) setSelection(next);
    };
    window.addEventListener(TASK_SELECT_EVENT, onSelect);
    return () => window.removeEventListener(TASK_SELECT_EVENT, onSelect);
  }, []);

  const board = tasks.board;
  const selected: Task | null =
    // By id, or by path once a file without an id has been given one.
    allTasks(board).find((task) => task.id === selection?.id) ??
    allTasks(board).find((task) => task.path === selection?.path) ??
    null;

  // Follow the selected task as it gains an id, is renamed, or moves.
  const selectedId = selected?.id;
  const selectedPath = selected?.path;
  useEffect(() => {
    if (selectedId === undefined || selectedPath === undefined) {
      rememberedSelection = selection;
      return;
    }
    rememberedSelection = { id: selectedId, path: selectedPath };
    if (selection?.id !== selectedId || selection?.path !== selectedPath) {
      setSelection({ id: selectedId, path: selectedPath });
    }
  }, [selectedId, selectedPath, selection]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      if (
        mod &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (
        mod &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "z" &&
        !isEditable(event.target)
      ) {
        const undo = takeTaskUndo();
        if (!undo) return;
        event.preventDefault();
        void undo.run();
        return;
      }
      if (event.key !== "Escape" || isEditable(event.target) || overlayOpen()) {
        return;
      }
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshTasks();
      await refreshLinkStatuses(peekTasks().board);
    } finally {
      setRefreshing(false);
    }
  };

  // Link states load when Tasks opens (once the board is there) and on
  // Refresh; never in the background.
  const boardReady = board !== null;
  useEffect(() => {
    if (boardReady) void refreshLinkStatuses(peekTasks().board);
  }, [boardReady]);

  const firstColumn = board?.columns[0]?.name ?? null;
  const filtering = isTaskFilterActive(filter);
  const doneColumn = board?.doneColumn ?? null;
  const visible = useMemo(
    () =>
      filtering ? (task: Task) => taskMatches(task, filter, doneColumn) : null,
    [filtering, filter, doneColumn],
  );
  const tags = useMemo(
    () =>
      [...new Set(allTasks(board).flatMap((task) => task.tags))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [board],
  );

  return (
    <div
      role="region"
      aria-label="Tasks"
      data-app-tasks
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <CheckList
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Tasks</span>
        </div>
        {board && firstColumn ? (
          <button
            type="button"
            title={`New task in ${firstColumn}`}
            aria-label="New task"
            onClick={() => setCreatingIn(firstColumn)}
            className="mr-1 grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
          >
            <Plus className="size-3.5" strokeWidth={1.75} />
          </button>
        ) : null}
        {tasks.root ? (
          <button
            type="button"
            title="Refresh — read the task files again"
            aria-label="Refresh"
            disabled={refreshing}
            onClick={() => void refresh()}
            className="mr-2 grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content disabled:opacity-40"
          >
            <RefreshCw
              className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
              strokeWidth={1.75}
            />
          </button>
        ) : null}
        {IS_MAC ? null : <WindowControls />}
      </div>
      {tasks.status === "unconfigured" ? (
        <TasksSetup />
      ) : tasks.status === "missing" ? (
        <TasksNotice
          title="The tasks folder cannot be found"
          body={`${tasks.root ?? ""} is missing. If it lives on a disk that is not connected, connect it and try again.`}
          primary={{ label: "Try again", run: () => void refreshTasks() }}
          secondary={{
            label: "Choose another folder…",
            run: () => void promptForTasksRoot(),
          }}
        />
      ) : tasks.status === "error" ? (
        <TasksNotice
          title="Tasks could not be read"
          body={tasks.error ?? ""}
          primary={{ label: "Try again", run: () => void refreshTasks() }}
        />
      ) : !board ? (
        <div className="flex-1" aria-busy="true" />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TaskFilterBar
              ref={searchRef}
              filter={filter}
              tags={tags}
              onChange={setFilter}
            />
            <TaskBoardList
              board={board}
              selectedId={selected?.id ?? null}
              visible={visible}
              forceOpen={filtering}
              creatingIn={creatingIn}
              onCreatingIn={setCreatingIn}
              onSelect={(task) => setSelection(task)}
              onCreated={(task) => setSelection(task)}
            />
          </div>
          {selected ? (
            <TaskDetail
              board={board}
              task={selected}
              onClose={() => setSelection(null)}
            >
              {onOpenSession ? (
                <TaskSessionsField
                  task={selected}
                  recents={recents}
                  defaultCwd={defaultCwd}
                  sessions={sessions}
                  onOpenSession={onOpenSession}
                />
              ) : null}
            </TaskDetail>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TasksSetup() {
  return (
    <TasksNotice
      title="Choose a folder for Tasks"
      body="Tasks are plain markdown files: one file per task, inside a folder for each column (TODO, In Progress, Done). Pick an empty folder to start fresh, or a folder whose subfolders should become columns. You can change it later in Settings."
      primary={{
        label: "Choose folder…",
        run: () => void promptForTasksRoot(),
      }}
    />
  );
}

type NoticeAction = { label: string; run: () => void };

function TasksNotice({
  title,
  body,
  primary,
  secondary,
}: {
  title: string;
  body: string;
  primary: NoticeAction;
  secondary?: NoticeAction;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <CheckList className="size-6 text-content/30" strokeWidth={1.5} />
        <h2 className="text-[14px] font-medium text-content">{title}</h2>
        <p className="text-[12px] leading-relaxed text-content/55">{body}</p>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={primary.run}
            className="rounded-md bg-content px-3 py-1 text-[12px] font-medium text-background-base hover:bg-content/80"
          >
            {primary.label}
          </button>
          {secondary ? (
            <button
              type="button"
              onClick={secondary.run}
              className="rounded-md bg-content/10 px-3 py-1 text-[12px] text-content/70 hover:bg-content/20"
            >
              {secondary.label}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
