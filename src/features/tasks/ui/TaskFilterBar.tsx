import { forwardRef } from "react";
import { Search, X } from "../../../shared/ui/icons";
import { TASK_PRIORITIES } from "../model/tasks";
import {
  EMPTY_TASK_FILTER,
  isTaskFilterActive,
  type TaskFilter,
} from "../model/taskFilter";

const SELECT =
  "h-6 rounded-md border border-content/10 bg-transparent px-1.5 text-[11px] text-content/70 outline-none focus:border-accent";

export const TaskFilterBar = forwardRef<
  HTMLInputElement,
  {
    filter: TaskFilter;
    tags: string[];
    onChange: (filter: TaskFilter) => void;
  }
>(function TaskFilterBar({ filter, tags, onChange }, ref) {
  const set = (patch: Partial<TaskFilter>) => onChange({ ...filter, ...patch });
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-stroke px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <Search
          className="size-3.5 shrink-0 text-content/35"
          strokeWidth={1.75}
        />
        <input
          ref={ref}
          value={filter.query}
          aria-label="Search tasks"
          placeholder="Search tasks"
          onChange={(event) => set({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && filter.query) {
              event.preventDefault();
              event.stopPropagation();
              set({ query: "" });
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[12px] text-content outline-none placeholder:text-content/30"
        />
      </div>
      <select
        aria-label="Filter by tag"
        value={filter.tag ?? ""}
        onChange={(event) => set({ tag: event.target.value || null })}
        className={SELECT}
      >
        <option value="">Any tag</option>
        {tags.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by priority"
        value={filter.priority ?? ""}
        onChange={(event) => set({ priority: event.target.value || null })}
        className={SELECT}
      >
        <option value="">Any priority</option>
        {TASK_PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {priority[0].toUpperCase() + priority.slice(1)}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by links"
        value={filter.links}
        onChange={(event) =>
          set({ links: event.target.value as TaskFilter["links"] })
        }
        className={SELECT}
      >
        <option value="any">Any links</option>
        <option value="with">With links</option>
        <option value="without">No links</option>
      </select>
      <button
        type="button"
        aria-pressed={filter.overdue}
        onClick={() => set({ overdue: !filter.overdue })}
        className={`h-6 rounded-md border px-2 text-[11px] ${
          filter.overdue
            ? "border-red-400/40 bg-red-500/10 text-red-400"
            : "border-content/10 text-content/60 hover:bg-content/5"
        }`}
      >
        Overdue
      </button>
      {isTaskFilterActive(filter) ? (
        <button
          type="button"
          aria-label="Clear filters"
          title="Clear filters"
          onClick={() => onChange(EMPTY_TASK_FILTER)}
          className="grid size-6 place-items-center rounded-md text-content/40 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
});
