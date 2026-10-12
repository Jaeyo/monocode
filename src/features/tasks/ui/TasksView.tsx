import { useEffect, useRef, useState } from "react";
import { CheckList, RefreshCw } from "../../../shared/ui/icons";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { refreshTasks, useTasks } from "../model/tasksStore";
import { promptForTasksRoot } from "../model/tasksRoot";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
};

export function TasksView({
  besideRail = false,
  compactRail = false,
  onClose,
  onToggleSidebar,
}: Props) {
  const tasks = useTasks();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
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
    } finally {
      setRefreshing(false);
    }
  };

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
      <TasksBody />
    </div>
  );
}

function TasksBody() {
  const tasks = useTasks();
  if (tasks.status === "unconfigured") return <TasksSetup />;
  if (tasks.status === "missing") {
    return (
      <TasksNotice
        title="The tasks folder cannot be found"
        body={`${tasks.root ?? ""} is missing. If it lives on a disk that is not connected, connect it and try again.`}
        primary={{ label: "Try again", run: () => void refreshTasks() }}
        secondary={{
          label: "Choose another folder…",
          run: () => void promptForTasksRoot(),
        }}
      />
    );
  }
  if (tasks.status === "error") {
    return (
      <TasksNotice
        title="Tasks could not be read"
        body={tasks.error ?? ""}
        primary={{ label: "Try again", run: () => void refreshTasks() }}
      />
    );
  }
  if (!tasks.board) {
    return <div className="flex-1" aria-busy="true" />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {tasks.board.columns.map((column) => (
        <section key={column.name} className="mb-4">
          <h2 className="text-[12px] font-medium text-content/60">
            {column.name}
          </h2>
          {column.tasks.map((task) => (
            <div key={task.id} className="py-1 text-[13px]">
              {task.title}
            </div>
          ))}
        </section>
      ))}
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
