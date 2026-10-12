import { useState } from "react";
import { Modal } from "../../../shared/ui/Modal";
import { showToast } from "../../../shared/ui/Toasts";
import type { Task } from "../model/tasks";
import { createTask, useTasks } from "../model/tasksStore";
import { promptForTasksRoot } from "../model/tasksRoot";

/** ⌘⇧T from anywhere: a title and a column, then back to what you were doing. */
export function QuickTaskDialog({
  onClose,
  onOpenTask,
}: {
  onClose: () => void;
  onOpenTask: (task: Task) => void;
}) {
  const tasks = useTasks();
  const columns = tasks.board?.columns ?? [];
  const [title, setTitle] = useState("");
  const [picked, setColumn] = useState<string | null>(null);
  // The first column until one is picked, even if the board arrives later.
  const column =
    picked && columns.some((entry) => entry.name === picked)
      ? picked
      : (columns[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const ready = tasks.status === "ready" && columns.length > 0;

  const submit = async () => {
    const value = title.trim();
    if (!value || !column || busy) return;
    setBusy(true);
    const created = await createTask(column, value);
    setBusy(false);
    if (!created) return;
    onClose();
    showToast(`Created “${created.title}” in ${column}.`, {
      action: { label: "Open", run: () => onOpenTask(created) },
    });
  };

  return (
    <Modal onClose={onClose} size="sm" title="New Task">
      {ready ? (
        <form
          className="flex flex-col gap-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            autoFocus
            value={title}
            aria-label="Task title"
            placeholder="Task title"
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-md border border-content/15 bg-transparent px-2.5 py-1.5 text-[13px] text-content outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-content/55">
              Column
              <select
                value={column}
                aria-label="Column"
                onChange={(event) => setColumn(event.target.value)}
                className="rounded-md border border-content/15 bg-transparent px-1.5 py-0.5 text-[12px] text-content"
              >
                {columns.map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-content/10 px-3 py-1 text-[12px] text-content/70 hover:bg-content/20"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || busy}
              className="rounded-md bg-content px-3 py-1 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-30"
            >
              Create
            </button>
          </div>
        </form>
      ) : tasks.status === "loading" ? (
        <p className="p-4 text-[12px] text-content/55">Loading tasks…</p>
      ) : (
        <div className="flex flex-col gap-3 p-4 text-[12px] text-content/70">
          <p>
            {tasks.status === "missing"
              ? "The tasks folder cannot be found."
              : tasks.status === "error"
                ? `Tasks could not be read: ${tasks.error ?? ""}`
                : "Tasks are not set up yet. Choose a folder to keep them in."}
          </p>
          <button
            type="button"
            onClick={() => {
              onClose();
              void promptForTasksRoot();
            }}
            className="self-start rounded-md bg-content px-3 py-1 text-[12px] font-medium text-background-base hover:bg-content/80"
          >
            Choose folder…
          </button>
        </div>
      )}
    </Modal>
  );
}
