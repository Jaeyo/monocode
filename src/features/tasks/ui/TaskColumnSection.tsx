import { Fragment, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronRight, MoreHorizontal, Plus } from "../../../shared/ui/icons";
import type { Task, TaskColumn, TaskLink } from "../model/tasks";
import { InlineInput } from "./InlineInput";
import { TaskCard } from "./TaskCard";
import type { TaskDropTarget } from "./useTaskDrag";

type Props = {
  column: TaskColumn;
  doneColumn: string | null;
  collapsed: boolean;
  selectedId: string | null;
  /** Tasks shown; a filter may hide some of the column's tasks. */
  tasks: Task[];
  creating: boolean;
  renaming: boolean;
  dragDisabled: boolean;
  draggingId: string | null;
  dropTarget: TaskDropTarget | null;
  columnDropBefore: boolean;
  setSectionRef: (el: HTMLElement | null) => void;
  setCardRef: (id: string, el: HTMLElement | null) => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onToggleCollapsed: () => void;
  onStartCreate: () => void;
  onCreate: (title: string) => void;
  onCancelCreate: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onColumnMenu: (x: number, y: number) => void;
  onSelect: (task: Task) => void;
  onCardPointerDown: (
    task: Task,
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  onCardMenu: (task: Task, event: ReactMouseEvent<HTMLElement>) => void;
  onOpenLink: (link: TaskLink) => void;
};

function DropLine() {
  return <div aria-hidden className="mx-1 h-0.5 rounded-full bg-accent" />;
}

export function TaskColumnSection(props: Props) {
  const { column, collapsed, tasks, draggingId, dropTarget, dragDisabled } =
    props;
  const dropHere = dropTarget?.column === column.name ? dropTarget : null;
  // The drop index counts the other tasks, so skip the dragged one.
  let visibleIndex = 0;
  return (
    <section
      ref={props.setSectionRef}
      aria-label={column.name}
      className={`flex flex-col gap-0.5 rounded-lg pb-2 ${
        dropHere && collapsed ? "bg-accent/10" : ""
      } ${props.columnDropBefore ? "border-t-2 border-accent" : ""}`}
    >
      <header
        onPointerDown={dragDisabled ? undefined : props.onHeaderPointerDown}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onColumnMenu(event.clientX, event.clientY);
        }}
        className="group/header flex h-8 select-none items-center gap-1 px-1"
      >
        <button
          type="button"
          data-no-drag
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? `Expand ${column.name}` : `Collapse ${column.name}`
          }
          onClick={props.onToggleCollapsed}
          className="grid size-5 place-items-center rounded text-content/45 hover:bg-content/10 hover:text-content"
        >
          <ChevronRight
            className={`size-3 transition-transform ${collapsed ? "" : "rotate-90"}`}
            strokeWidth={2}
          />
        </button>
        {props.renaming ? (
          <InlineInput
            initial={column.name}
            ariaLabel="Column name"
            commitOnBlur
            className="flex-1"
            onCommit={props.onRename}
            onCancel={props.onCancelRename}
          />
        ) : (
          <h2 className="min-w-0 truncate text-[12px] font-semibold text-content/70">
            {column.name}
          </h2>
        )}
        <span className="text-[11px] tabular-nums text-content/35">
          {column.tasks.length}
        </span>
        {props.doneColumn === column.name &&
        column.name.toLowerCase() !== "done" ? (
          <span className="rounded bg-content/10 px-1 text-[10px] text-content/45">
            Done
          </span>
        ) : null}
        {column.configured ? null : (
          <span
            className="rounded bg-content/10 px-1 text-[10px] text-content/45"
            title="This folder is not in .tasks.json yet; it is listed after the configured columns."
          >
            New folder
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          data-no-drag
          aria-label={`New task in ${column.name}`}
          title="New task"
          onClick={props.onStartCreate}
          className="grid size-6 place-items-center rounded text-content/40 opacity-0 hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/header:opacity-100"
        >
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          data-no-drag
          aria-label={`${column.name} options`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            props.onColumnMenu(rect.left, rect.bottom);
          }}
          className="grid size-6 place-items-center rounded text-content/40 opacity-0 hover:bg-content/10 hover:text-content focus-visible:opacity-100 group-hover/header:opacity-100"
        >
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </button>
      </header>
      {props.creating ? (
        <div className="px-1 pb-1">
          <InlineInput
            ariaLabel="New task title"
            placeholder="Task title"
            className="w-full"
            onCommit={props.onCreate}
            onCancel={props.onCancelCreate}
          />
        </div>
      ) : null}
      {collapsed ? null : (
        <div role="list" className="flex flex-col gap-0.5">
          {tasks.map((task) => {
            const index = task.id === draggingId ? -1 : visibleIndex++;
            return (
              <Fragment key={task.id}>
                {dropHere && index >= 0 && dropHere.index === index ? (
                  <DropLine />
                ) : null}
                <TaskCard
                  task={task}
                  doneColumn={props.doneColumn}
                  selected={task.id === props.selectedId}
                  dragging={task.id === draggingId}
                  setRef={(el) => props.setCardRef(task.id, el)}
                  onSelect={() => props.onSelect(task)}
                  onPointerDown={(event) =>
                    dragDisabled
                      ? undefined
                      : props.onCardPointerDown(task, event)
                  }
                  onContextMenu={(event) => {
                    event.preventDefault();
                    props.onCardMenu(task, event);
                  }}
                  onOpenLink={props.onOpenLink}
                />
              </Fragment>
            );
          })}
          {dropHere && dropHere.index >= visibleIndex ? <DropLine /> : null}
          {tasks.length === 0 && !props.creating ? (
            <div className="px-2.5 py-1.5 text-[12px] text-content/30">
              {column.tasks.length === 0 ? "No tasks" : "No matching tasks"}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
