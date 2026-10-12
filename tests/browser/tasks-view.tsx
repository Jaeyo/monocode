import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { TasksView } from "../../src/features/tasks/ui/TasksView";
import { ToastHost } from "../../src/shared/ui/Toasts";
import { startTasks } from "../../src/features/tasks/model/tasksStore";
import type {
  Task,
  TaskBoard,
  TaskColumn,
  TaskEdit,
} from "../../src/features/tasks/model/tasks";
import type { InboxItem } from "../../src/features/inbox/model/githubTasks";
import { InboxTaskControls } from "../../src/features/tasks/ui/TaskInboxActions";
import "../../src/styles/index.css";

// An in-memory stand-in for the Rust tasks commands: enough of their
// behaviour to drive the real view.
const ROOT = "/tmp/fixture-tasks";
type Column = { name: string; tasks: Task[] };
let columns: Column[] | null = null;
let doneColumn: string | null = null;
const trash = new Map<string, { column: string; index: number; task: Task }>();
let nextId = 1;
const calls: string[] = [];

function task(title: string, column: string, extra: Partial<Task> = {}): Task {
  const id = `T${nextId++}`;
  return {
    id,
    persisted: true,
    path: `${column}/${title}.md`,
    column,
    fileName: `${title}.md`,
    title,
    status: "",
    due: null,
    priority: null,
    tags: [],
    links: [],
    sessions: [],
    project: null,
    todos: [],
    document: "",
    readOnly: false,
    error: null,
    duplicate: false,
    modifiedAt: 0,
    ...extra,
  };
}

function board(): TaskBoard {
  return {
    root: ROOT,
    configured: true,
    doneColumn,
    warnings: [],
    columns: (columns ?? []).map((column): TaskColumn => ({
      name: column.name,
      configured: true,
      exists: true,
      tasks: column.tasks.map((entry) => ({ ...entry, column: column.name })),
    })),
  };
}

function find(id: string) {
  for (const column of columns ?? []) {
    const index = column.tasks.findIndex((entry) => entry.id === id);
    if (index >= 0) return { column, index, task: column.tasks[index] };
  }
  throw new Error("stale: the task was not found");
}

function edit(current: Task, change: TaskEdit): Task {
  const next = { ...current, todos: [...current.todos] };
  switch (change.type) {
    case "toggleTodo": {
      const index = next.todos.findIndex((todo) => todo.text === change.text);
      if (index < 0) throw new Error("stale: the todo changed outside the app");
      next.todos[index] = { ...next.todos[index], done: change.done };
      return next;
    }
    case "setStatus":
      return { ...next, status: change.status };
    case "setTitle":
      return { ...next, title: change.title };
    case "setDue":
      return { ...next, due: change.due };
    case "setPriority":
      return { ...next, priority: change.priority };
    case "setTags":
      return { ...next, tags: change.tags };
    case "addLink":
      return { ...next, links: [...next.links, change.link] };
    case "removeLink":
      return { ...next, links: next.links.filter((l) => l.url !== change.url) };
    case "addTodo":
      next.todos.push({ text: change.text, done: false });
      return next;
    case "renameTodo":
      next.todos[change.index] = {
        ...next.todos[change.index],
        text: change.newText,
      };
      return next;
    case "removeTodo":
      next.todos.splice(change.index, 1);
      return next;
    case "moveTodo": {
      const [todo] = next.todos.splice(change.index, 1);
      next.todos.splice(change.to, 0, todo);
      return next;
    }
    case "saveDocument":
      return { ...next, document: change.document.trim() };
    default:
      return next;
  }
}

mockWindows("main");
mockIPC(
  (command, payload) => {
    calls.push(command);
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (command) {
      case "plugin:dialog|open":
        return ROOT;
      case "tasks_init":
        columns ??= [
          {
            name: "TODO",
            tasks: [
              task("Write the spec", "TODO", {
                status: "Waiting on API review",
                todos: [
                  { text: "Draft", done: true },
                  { text: "Review", done: false },
                ],
                links: [
                  {
                    provider: "github",
                    repo: "o/r",
                    kind: "pr",
                    number: 7,
                    url: "https://github.com/o/r/pull/7",
                    title: "Spec PR",
                  },
                ],
              }),
              task("Fix login", "TODO", {
                due: "2000-01-01",
                priority: "high",
              }),
            ],
          },
          { name: "In Progress", tasks: [] },
          { name: "Done", tasks: [task("Shipped", "Done")] },
        ];
        doneColumn = "Done";
        return board();
      case "tasks_load":
        if (!columns) throw new Error("not_found: missing");
        return board();
      case "tasks_create": {
        const column = columns!.find((entry) => entry.name === args.column)!;
        const created = task(String(args.title), column.name);
        column.tasks.unshift(created);
        return { ...created };
      }
      case "tasks_update": {
        const found = find(String(args.id));
        const next = edit(found.task, args.edit as TaskEdit);
        found.column.tasks[found.index] = next;
        return { ...next, column: found.column.name };
      }
      case "tasks_move": {
        const found = find(String(args.id));
        found.column.tasks.splice(found.index, 1);
        const target = columns!.find((entry) => entry.name === args.column)!;
        target.tasks.splice(Number(args.index), 0, found.task);
        return board();
      }
      case "tasks_delete": {
        const found = find(String(args.id));
        found.column.tasks.splice(found.index, 1);
        const token = `tok${nextId++}`;
        trash.set(token, {
          column: found.column.name,
          index: found.index,
          task: found.task,
        });
        return token;
      }
      case "tasks_restore": {
        const entry = trash.get(String(args.token))!;
        trash.delete(String(args.token));
        columns!
          .find((column) => column.name === entry.column)!
          .tasks.splice(entry.index, 0, entry.task);
        return board();
      }
      case "tasks_trash_flush":
        return null;
      case "tasks_column_rename": {
        const column = columns!.find((entry) => entry.name === args.from)!;
        column.name = String(args.to);
        if (doneColumn === args.from) doneColumn = column.name;
        return board();
      }
      case "tasks_column_add": {
        const at = columns!.findIndex((entry) => entry.name === args.after);
        columns!.splice(at < 0 ? columns!.length : at + 1, 0, {
          name: String(args.name),
          tasks: [],
        });
        return board();
      }
      case "tasks_column_reorder": {
        const names = args.names as string[];
        columns!.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
        return board();
      }
      case "tasks_column_set_done":
        doneColumn = (args.name as string | null) ?? null;
        return board();
      case "git_github_item_states":
        // The fixture's only pull request has been merged.
        return {
          items: (
            args.items as { repo: string; kind: string; number: number }[]
          )
            .filter((item) => item.repo === "o/r" && item.number === 7)
            .map((item) => ({
              ...item,
              state: "MERGED",
              title: "Spec PR",
              updatedAt: "2026-10-10T00:00:00Z",
            })),
          rateLimit: null,
        };
      case "plugin:window|is_maximized":
        return false;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  },
  { shouldMockEvents: true },
);

Object.assign(window, {
  calls,
  columnTitles: () =>
    Object.fromEntries(
      (columns ?? []).map((column) => [
        column.name,
        column.tasks.map((entry) => entry.title),
      ]),
    ),
  taskNamed: (title: string) =>
    (columns ?? [])
      .flatMap((column) => column.tasks)
      .find((entry) => entry.title === title),
});

localStorage.clear();
startTasks();
// The Inbox detail header's task controls, for an item no task links yet.
const inboxItem: InboxItem = {
  kind: "issue",
  number: 42,
  title: "Crash on start",
  url: "https://github.com/o/r/issues/42",
  state: "open",
  updatedAt: "2026-10-01T00:00:00Z",
  labels: [],
  assignees: [],
  draft: false,
  repo: "o/r",
  projectPath: "/p",
  provider: "github",
};
const opened: string[] = [];
Object.assign(window, { opened });

createRoot(document.getElementById("root")!).render(
  <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
    <div
      data-inbox-fixture
      style={{
        display: "flex",
        gap: 8,
        padding: 8,
        borderBottom: "1px solid #333",
      }}
    >
      <InboxTaskControls
        item={inboxItem}
        onOpenTask={(task) => opened.push(task.title)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-content/15 px-2 text-[12px] text-content/80"
      />
    </div>
    <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
      <TasksView besideRail onClose={() => undefined} />
    </div>
    <ToastHost />
  </div>,
);
