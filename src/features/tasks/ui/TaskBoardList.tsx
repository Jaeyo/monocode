import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useMemo, useRef, useState } from "react";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { useSortable } from "../../../shared/hooks/useSortable";
import { Plus } from "../../../shared/ui/icons";
import { Modal } from "../../../shared/ui/Modal";
import { showToast } from "../../../shared/ui/Toasts";
import { openPathWithDefaultApp, revealPath } from "../../../platform/tauri/fs";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../files/ui/ExplorerMenu";
import type { Task, TaskBoard, TaskColumn, TaskLink } from "../model/tasks";
import { createTask, editColumns } from "../model/tasksStore";
import { deleteTaskWithUndo, moveTaskWithUndo } from "../model/taskActions";
import {
  isColumnCollapsed,
  setColumnCollapsed,
  taskFilePath,
} from "../model/taskViewState";
import { InlineInput } from "./InlineInput";
import { TaskColumnSection } from "./TaskColumnSection";
import { useTaskDrag } from "./useTaskDrag";

type Menu =
  | { kind: "task"; x: number; y: number; task: Task }
  | { kind: "column"; x: number; y: number; column: TaskColumn };

type Props = {
  board: TaskBoard;
  selectedId: string | null;
  /** When set, only these tasks show and dragging is off. */
  visible: ((task: Task) => boolean) | null;
  /** Columns a filter forces open. */
  forceOpen: boolean;
  creatingIn: string | null;
  onCreatingIn: (column: string | null) => void;
  onSelect: (task: Task) => void;
  onCreated: (task: Task) => void;
};

export function TaskBoardList({
  board,
  selectedId,
  visible,
  forceOpen,
  creatingIn,
  onCreatingIn,
  onSelect,
  onCreated,
}: Props) {
  const root = board.root;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  // Bumped after a fold is stored, so the stored folds are read again.
  const [, setCollapsedRevision] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [addingAfter, setAddingAfter] = useState<string | null | undefined>(
    undefined,
  );
  const [menu, setMenu] = useState<Menu | null>(null);
  const [deleting, setDeleting] = useState<TaskColumn | null>(null);

  const collapsed = (column: string) =>
    !forceOpen && isColumnCollapsed(root, column, board.doneColumn);

  const dragDisabled = visible !== null;
  const tasksById = useMemo(() => {
    const map = new Map<string, Task>();
    for (const column of board.columns) {
      for (const task of column.tasks) map.set(task.id, task);
    }
    return map;
  }, [board]);

  const drag = useTaskDrag({
    columns: board.columns,
    collapsed,
    scroller: () => scrollRef.current,
    onDrop: (taskId, target) => {
      const task = tasksById.get(taskId);
      if (!task) return;
      const from = board.columns
        .find((column) => column.name === task.column)
        ?.tasks.findIndex((entry) => entry.id === taskId);
      if (target.column === task.column && target.index === from) return;
      void moveTaskWithUndo(task, target.column, target.index);
    },
  });

  const columnNames = useMemo(
    () => board.columns.map((column) => column.name),
    [board.columns],
  );
  const columnSort = useSortable(
    columnNames,
    (names) => void editColumns({ type: "reorder", names }),
    "y",
  );

  const openLink = useCallback((link: TaskLink) => {
    if (link.url) void openUrl(link.url).catch(() => undefined);
  }, []);

  const toggleCollapsed = (column: string) => {
    setColumnCollapsed(root, column, !collapsed(column));
    setCollapsedRevision((value) => value + 1);
  };

  const create = async (column: string, title: string) => {
    onCreatingIn(null);
    if (collapsed(column)) toggleCollapsed(column);
    const task = await createTask(column, title);
    if (task) onCreated(task);
  };

  const taskMenuItems = (task: Task): ExplorerMenuItem[] => [
    { kind: "item", id: "open", label: "Open" },
    {
      kind: "item",
      id: "move",
      label: "Move to",
      submenu: board.columns
        .filter((column) => column.name !== task.column)
        .map((column) => ({
          kind: "item" as const,
          id: `move:${column.name}`,
          label: column.name,
        })),
      disabled: board.columns.length < 2,
    },
    { kind: "sep" },
    { kind: "item", id: "reveal", label: "Reveal in Finder" },
    { kind: "item", id: "external", label: "Open in Default App" },
    { kind: "item", id: "copy-path", label: "Copy File Path" },
    { kind: "sep" },
    { kind: "item", id: "delete", label: "Delete", danger: true },
  ];

  const columnMenuItems = (column: TaskColumn): ExplorerMenuItem[] => [
    { kind: "item", id: "new", label: "New Task" },
    { kind: "item", id: "rename", label: "Rename" },
    {
      kind: "item",
      id: "done",
      label: "Done Column",
      description: "Tasks here count as finished",
      checked: board.doneColumn === column.name,
    },
    { kind: "item", id: "add-after", label: "Add Column After" },
    { kind: "sep" },
    {
      kind: "item",
      id: "delete",
      label: "Delete Column",
      danger: true,
      disabled: board.columns.length <= 1,
    },
  ];

  const pickTaskMenu = (task: Task, id: string) => {
    if (id === "open") onSelect(task);
    else if (id.startsWith("move:")) {
      void moveTaskWithUndo(task, id.slice("move:".length), 0);
    } else if (id === "reveal") {
      void revealPath(taskFilePath(root, task)).catch(() => undefined);
    } else if (id === "external") {
      void openPathWithDefaultApp(taskFilePath(root, task)).catch((error) =>
        showToast(String(error), { tone: "error" }),
      );
    } else if (id === "copy-path") {
      void navigator.clipboard.writeText(taskFilePath(root, task));
    } else if (id === "delete") {
      void deleteTaskWithUndo(task);
    }
  };

  const pickColumnMenu = (column: TaskColumn, id: string) => {
    if (id === "new") onCreatingIn(column.name);
    else if (id === "rename") setRenaming(column.name);
    else if (id === "done") {
      void editColumns({
        type: "setDone",
        name: board.doneColumn === column.name ? null : column.name,
      });
    } else if (id === "add-after") setAddingAfter(column.name);
    else if (id === "delete") {
      // An empty column goes straight to the trash; a full one asks where
      // its tasks should go.
      if (column.tasks.length === 0) {
        void editColumns({ type: "delete", name: column.name });
      } else setDeleting(column);
    }
  };

  return (
    <div
      ref={(el) => {
        scrollRef.current = el;
        lockOverscroll(el);
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
    >
      {board.warnings.map((warning) => (
        <div
          key={warning}
          role="alert"
          className="mb-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[12px] text-amber-400"
        >
          {warning}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        {board.columns.map((column, index) => {
          const isCollapsed = collapsed(column.name);
          const tasks = visible ? column.tasks.filter(visible) : column.tasks;
          return (
            <div key={column.name}>
              <TaskColumnSection
                column={column}
                doneColumn={board.doneColumn}
                collapsed={isCollapsed}
                selectedId={selectedId}
                tasks={tasks}
                creating={creatingIn === column.name}
                renaming={renaming === column.name}
                dragDisabled={dragDisabled}
                draggingId={drag.draggingId}
                dropTarget={drag.target}
                columnDropBefore={
                  columnSort.draggingId !== null &&
                  columnSort.toIndex === index &&
                  columnSort.fromIndex !== index
                }
                setSectionRef={(el) => {
                  drag.setColumnRef(column.name, el);
                  columnSort.setItemRef(column.name, el);
                }}
                setCardRef={drag.setCardRef}
                onHeaderPointerDown={(event) =>
                  columnSort.onItemPointerDown(column.name, event)
                }
                onToggleCollapsed={() => toggleCollapsed(column.name)}
                onStartCreate={() => onCreatingIn(column.name)}
                onCreate={(title) => void create(column.name, title)}
                onCancelCreate={() => onCreatingIn(null)}
                onRename={(name) => {
                  setRenaming(null);
                  if (name !== column.name) {
                    void editColumns({
                      type: "rename",
                      from: column.name,
                      to: name,
                    });
                  }
                }}
                onCancelRename={() => setRenaming(null)}
                onColumnMenu={(x, y) =>
                  setMenu({ kind: "column", x, y, column })
                }
                onSelect={(task) => {
                  if (drag.consumeClick()) return;
                  onSelect(task);
                }}
                onCardPointerDown={(task, event) =>
                  drag.onCardPointerDown(task.id, event)
                }
                onCardMenu={(task, event) =>
                  setMenu({
                    kind: "task",
                    x: event.clientX,
                    y: event.clientY,
                    task,
                  })
                }
                onOpenLink={openLink}
              />
              {addingAfter === column.name ? (
                <AddColumnInput
                  onDone={() => setAddingAfter(undefined)}
                  after={column.name}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {addingAfter === null ? (
        <AddColumnInput onDone={() => setAddingAfter(undefined)} />
      ) : (
        <button
          type="button"
          onClick={() => setAddingAfter(null)}
          className="mt-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-content/40 hover:bg-content/5 hover:text-content/70"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
          Add column
        </button>
      )}
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={menu.kind === "task" ? "Task actions" : "Column actions"}
          items={
            menu.kind === "task"
              ? taskMenuItems(menu.task)
              : columnMenuItems(menu.column)
          }
          onPick={(id) => {
            setMenu(null);
            if (menu.kind === "task") pickTaskMenu(menu.task, id);
            else pickColumnMenu(menu.column, id);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteColumnDialog
          column={deleting}
          others={board.columns.filter(
            (column) => column.name !== deleting.name,
          )}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function AddColumnInput({
  after,
  onDone,
}: {
  after?: string;
  onDone: () => void;
}) {
  return (
    <div className="px-1 py-1">
      <InlineInput
        ariaLabel="New column name"
        placeholder="Column name"
        className="w-full"
        onCommit={(name) => {
          onDone();
          void editColumns({ type: "add", name, after });
        }}
        onCancel={onDone}
      />
    </div>
  );
}

function DeleteColumnDialog({
  column,
  others,
  onClose,
}: {
  column: TaskColumn;
  others: TaskColumn[];
  onClose: () => void;
}) {
  const [target, setTarget] = useState(others[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const count = column.tasks.length;
  return (
    <Modal
      onClose={onClose}
      size="sm"
      title={`Delete “${column.name}”?`}
      description={`It holds ${count} ${count === 1 ? "task" : "tasks"}. They move to the column you choose, then the folder goes to the Trash.`}
    >
      <div className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1 text-[12px] text-content/70">
          Move tasks to
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="rounded-md border border-content/15 bg-transparent px-2 py-1 text-[12px] text-content"
          >
            {others.map((other) => (
              <option key={other.name} value={other.name}>
                {other.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-content/10 px-3 py-1 text-[12px] text-content/70 hover:bg-content/20"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!target || busy}
            onClick={async () => {
              setBusy(true);
              await editColumns({
                type: "delete",
                name: column.name,
                moveTo: target,
              });
              onClose();
            }}
            className="rounded-md bg-red-500/80 px-3 py-1 text-[12px] font-medium text-white hover:bg-red-500 disabled:opacity-40"
          >
            Move and Delete
          </button>
        </div>
      </div>
    </Modal>
  );
}
