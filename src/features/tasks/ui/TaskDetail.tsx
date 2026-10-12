import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import { useDragResize } from "../../../shared/hooks/useDragResize";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { useSortable } from "../../../shared/hooks/useSortable";
import {
  Check,
  CircleAlert,
  GripVertical,
  MoreHorizontal,
  Plus,
  X,
} from "../../../shared/ui/icons";
import { showToast } from "../../../shared/ui/Toasts";
import { IS_MAC } from "../../../platform/tauri/platform";
import { openPathWithDefaultApp, revealPath } from "../../../platform/tauri/fs";
import { AgentMarkdown } from "../../sessions/ui/AgentMarkdown";
import { MarkdownSourceEditor } from "../../sessions/ui/MarkdownSourceEditor";
import {
  MarkdownModeToggle,
  useMarkdownMode,
} from "../../sessions/ui/MarkdownModeToggle";
import { insertNoteImagesMarkdown } from "../../notes/noteImages";
import {
  ExplorerMenu,
  type ExplorerMenuItem,
} from "../../files/ui/ExplorerMenu";
import {
  allTasks,
  TASK_PRIORITIES,
  taskErrorText,
  type Task,
  type TaskBoard,
  type TaskEdit,
  type TaskLink,
} from "../model/tasks";
import { replaceTask, updateTask } from "../model/tasksStore";
import { deleteTaskWithUndo, moveTaskWithUndo } from "../model/taskActions";
import { taskFilePath } from "../model/taskViewState";
import {
  saveTaskImagesFromFiles,
  type TaskImagesResult,
} from "../model/taskImages";
import { InlineInput } from "./InlineInput";
import { TaskLinkChip } from "./TaskCard";

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 440;
let rememberedWidth = DEFAULT_WIDTH;

// Unsaved document edits, kept while the user looks at other tasks.
const drafts = new Map<string, string>();

type Props = {
  board: TaskBoard;
  task: Task;
  onClose: () => void;
  /** Extra rows (sessions) rendered under the links. */
  children?: ReactNode;
};

export function TaskDetail({ board, task, onClose, children }: Props) {
  const resize = useDragResize({
    direction: "left",
    min: MIN_WIDTH,
    max: () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.6)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth,
    onCommit: (width) => {
      rememberedWidth = width;
    },
  });
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const readOnly = task.readOnly;

  // A file without an id gets one on its first edit. Carry any unsaved
  // document text over before the editor remounts under the new id.
  const previous = useRef(task);
  if (previous.current.id !== task.id && previous.current.path === task.path) {
    const draft = drafts.get(previous.current.id);
    if (draft !== undefined) {
      drafts.delete(previous.current.id);
      drafts.set(task.id, draft);
    }
  }
  previous.current = task;

  const edit = (change: TaskEdit) => void updateTask(task, change);

  const allTags = useMemo(
    () =>
      [...new Set(allTasks(board).flatMap((entry) => entry.tags))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [board],
  );

  const menuItems: ExplorerMenuItem[] = [
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
    { kind: "item", id: "reveal", label: "Reveal in Finder" },
    { kind: "item", id: "external", label: "Open in Default App" },
    { kind: "item", id: "copy-path", label: "Copy File Path" },
    { kind: "sep" },
    { kind: "item", id: "delete", label: "Delete", danger: true },
  ];

  const pickMenu = (id: string) => {
    const path = taskFilePath(board.root, task);
    if (id.startsWith("move:")) {
      void moveTaskWithUndo(task, id.slice("move:".length), 0);
    } else if (id === "reveal") void revealPath(path).catch(() => undefined);
    else if (id === "external") {
      void openPathWithDefaultApp(path).catch((error) =>
        showToast(taskErrorText(error), { tone: "error" }),
      );
    } else if (id === "copy-path") void navigator.clipboard.writeText(path);
    else if (id === "delete") {
      onClose();
      void deleteTaskWithUndo(task);
    }
  };

  return (
    <aside
      ref={resize.setPaneRef}
      aria-label={`Task: ${task.title}`}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-stroke"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize task panel"
        className={`absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-stroke px-3">
        {editingTitle && !readOnly ? (
          <InlineInput
            initial={task.title}
            ariaLabel="Task title"
            commitOnBlur
            className="flex-1 text-[13px]"
            onCommit={(title) => {
              setEditingTitle(false);
              if (title !== task.title) edit({ type: "setTitle", title });
            }}
            onCancel={() => setEditingTitle(false)}
          />
        ) : (
          <button
            type="button"
            title={readOnly ? task.title : "Rename"}
            onClick={() => setEditingTitle(true)}
            className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-content"
          >
            {task.title}
          </button>
        )}
        <span className="shrink-0 text-[11px] text-content/40">
          {task.column}
        </span>
        <button
          type="button"
          aria-label="Task actions"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom });
          }}
          className="grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label="Close task"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-content/50 hover:bg-content/10 hover:text-content"
        >
          <X className="size-3.5" strokeWidth={1.75} />
        </button>
      </div>
      <div ref={lockOverscroll} className="min-h-0 flex-1 overflow-y-auto">
        {readOnly || task.duplicate ? (
          <div
            role="alert"
            className="m-3 mb-0 flex items-start gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-[12px] text-amber-400"
          >
            <CircleAlert
              className="mt-px size-3.5 shrink-0"
              strokeWidth={1.75}
            />
            <span>
              {readOnly
                ? `This file cannot be edited in MonoCode: ${task.error ?? "it could not be parsed"}. Fix it in an editor, then press Refresh.`
                : "Another file uses the same id. This copy gets a new id the next time you edit it."}
            </span>
          </div>
        ) : null}
        <div className="flex flex-col gap-3 p-3">
          <Field label="Status">
            <CommitInput
              value={task.status}
              placeholder="One line on where this stands"
              disabled={readOnly}
              ariaLabel="Status"
              onCommit={(status) => edit({ type: "setStatus", status })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due">
              <input
                type="date"
                aria-label="Due date"
                disabled={readOnly}
                value={
                  task.due && /^\d{4}-\d{2}-\d{2}$/.test(task.due)
                    ? task.due
                    : ""
                }
                onChange={(event) =>
                  edit({ type: "setDue", due: event.target.value || null })
                }
                className="w-full rounded border border-content/10 bg-transparent px-1.5 py-0.5 text-[12px] text-content outline-none focus:border-accent [color-scheme:dark] disabled:opacity-50"
              />
            </Field>
            <Field label="Priority">
              <select
                aria-label="Priority"
                disabled={readOnly}
                value={task.priority ?? ""}
                onChange={(event) =>
                  edit({
                    type: "setPriority",
                    priority: event.target.value || null,
                  })
                }
                className="w-full rounded border border-content/10 bg-transparent px-1.5 py-0.5 text-[12px] text-content outline-none focus:border-accent disabled:opacity-50"
              >
                <option value="">None</option>
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority[0].toUpperCase() + priority.slice(1)}
                  </option>
                ))}
                {task.priority &&
                !(TASK_PRIORITIES as readonly string[]).includes(
                  task.priority,
                ) ? (
                  <option value={task.priority}>{task.priority}</option>
                ) : null}
              </select>
            </Field>
          </div>
          <Field label="Tags">
            <TagsEditor
              tags={task.tags}
              known={allTags}
              disabled={readOnly}
              onChange={(tags) => edit({ type: "setTags", tags })}
            />
          </Field>
          <Field label="Links">
            <LinksEditor
              links={task.links}
              disabled={readOnly}
              onAdd={(link) => edit({ type: "addLink", link })}
              onRemove={(url) => edit({ type: "removeLink", url })}
            />
          </Field>
          {children}
          <Field label="Todos">
            <TodosEditor task={task} disabled={readOnly} onEdit={edit} />
          </Field>
        </div>
        <DocumentEditor key={task.id} board={board} task={task} />
      </div>
      {menu ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel="Task actions"
          items={menuItems}
          onPick={(id) => {
            setMenu(null);
            pickMenu(id);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-content/45">{label}</span>
      {children}
    </div>
  );
}

/** A text field that saves on Enter or blur, and shows file changes when idle. */
function CommitInput({
  value,
  placeholder,
  disabled,
  ariaLabel,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <input
      value={draft}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.stopPropagation();
          setDraft(value);
          focused.current = false;
          event.currentTarget.blur();
        }
      }}
      className="w-full rounded border border-content/10 bg-transparent px-1.5 py-1 text-[12px] text-content outline-none placeholder:text-content/30 focus:border-accent disabled:opacity-50"
    />
  );
}

function TagsEditor({
  tags,
  known,
  disabled,
  onChange,
}: {
  tags: string[];
  known: string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = "task-tag-suggestions";
  const add = () => {
    const tag = draft.trim();
    setDraft("");
    if (!tag || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-0.5 rounded bg-content/10 py-px pl-1.5 pr-0.5 text-[11px] text-content/70"
        >
          {tag}
          {disabled ? null : (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="grid size-3.5 place-items-center rounded text-content/40 hover:text-content"
            >
              <X className="size-2.5" strokeWidth={2} />
            </button>
          )}
        </span>
      ))}
      {disabled ? null : (
        <>
          <input
            value={draft}
            list={listId}
            aria-label="Add tag"
            placeholder={tags.length ? "" : "Add a tag"}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={add}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add();
              } else if (event.key === "Backspace" && !draft && tags.length) {
                onChange(tags.slice(0, -1));
              }
            }}
            className="min-w-16 flex-1 bg-transparent px-1 py-0.5 text-[12px] text-content outline-none placeholder:text-content/30"
          />
          <datalist id={listId}>
            {known
              .filter((tag) => !tags.includes(tag))
              .map((tag) => (
                <option key={tag} value={tag} />
              ))}
          </datalist>
        </>
      )}
    </div>
  );
}

/** A link pasted by hand; Inbox links carry their identity from the item. */
export function linkFromUrl(raw: string): TaskLink | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const github = /^\/([^/]+\/[^/]+)\/(pull|issues)\/(\d+)/.exec(url.pathname);
  if (url.hostname === "github.com" && github) {
    return {
      provider: "github",
      repo: github[1],
      kind: github[2] === "pull" ? "pr" : "issue",
      number: Number(github[3]),
      url: url.toString(),
      title: "",
    };
  }
  return {
    provider: "url",
    repo: "",
    kind: "",
    url: url.toString(),
    title: "",
  };
}

function LinksEditor({
  links,
  disabled,
  onAdd,
  onRemove,
}: {
  links: TaskLink[];
  disabled: boolean;
  onAdd: (link: TaskLink) => void;
  onRemove: (url: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-0.5">
      {links.length === 0 && !adding ? (
        <span className="text-[12px] text-content/30">
          Link Inbox items from Inbox, or paste a URL.
        </span>
      ) : null}
      {links.map((link) => (
        <div
          key={link.url}
          className="group/link flex min-w-0 items-center gap-1"
        >
          <TaskLinkChip
            link={link}
            onOpen={(entry) => void openUrl(entry.url).catch(() => undefined)}
          />
          {disabled ? null : (
            <button
              type="button"
              aria-label={`Remove link ${link.title || link.url}`}
              onClick={() => onRemove(link.url)}
              className="grid size-4 shrink-0 place-items-center rounded text-content/30 opacity-0 hover:text-content group-hover/link:opacity-100"
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          )}
        </div>
      ))}
      {adding ? (
        <InlineInput
          ariaLabel="Link URL"
          placeholder="https://…"
          className="w-full"
          onCommit={(value) => {
            setAdding(false);
            const link = linkFromUrl(value);
            if (link) onAdd(link);
            else showToast("That is not a web link.", { tone: "error" });
          }}
          onCancel={() => setAdding(false)}
        />
      ) : disabled ? null : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-fit items-center gap-1 rounded px-1 py-0.5 text-[11px] text-content/40 hover:bg-content/5 hover:text-content/70"
        >
          <Plus className="size-3" strokeWidth={1.75} />
          Add link
        </button>
      )}
    </div>
  );
}

function TodosEditor({
  task,
  disabled,
  onEdit,
}: {
  task: Task;
  disabled: boolean;
  onEdit: (edit: TaskEdit) => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const keys = task.todos.map((_, index) => `${index}`);
  const sortable = useSortable(
    keys,
    (_next, movedKey) => {
      if (movedKey == null) return;
      const from = Number(movedKey);
      const to = _next.indexOf(movedKey);
      const todo = task.todos[from];
      if (todo && to >= 0 && to !== from) {
        onEdit({ type: "moveTodo", index: from, text: todo.text, to });
      }
    },
    "y",
  );
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onEdit({ type: "addTodo", text });
  };
  return (
    <div className="flex flex-col gap-0.5">
      {task.todos.map((todo, index) => (
        <div
          key={`${index}:${todo.text}`}
          ref={(el) => sortable.setItemRef(`${index}`, el)}
          className={`group/todo flex min-w-0 items-start gap-1.5 rounded px-1 py-0.5 hover:bg-content/5 ${
            sortable.draggingId === `${index}` ? "opacity-40" : ""
          } ${
            sortable.toIndex === index && sortable.fromIndex !== index
              ? "border-t border-accent"
              : ""
          }`}
        >
          {disabled ? null : (
            <span
              aria-hidden
              onPointerDown={(event) =>
                sortable.onItemPointerDown(`${index}`, event)
              }
              className="mt-0.5 cursor-grab text-content/20 opacity-0 group-hover/todo:opacity-100"
            >
              <GripVertical className="size-3" strokeWidth={1.75} />
            </span>
          )}
          <button
            type="button"
            role="checkbox"
            aria-checked={todo.done}
            aria-label={todo.text}
            disabled={disabled}
            onClick={() =>
              onEdit({
                type: "toggleTodo",
                index,
                text: todo.text,
                done: !todo.done,
              })
            }
            className={`mt-[3px] grid size-3 shrink-0 place-items-center rounded-[3px] border disabled:opacity-40 ${
              todo.done
                ? "border-accent bg-accent text-white"
                : "border-content/30 hover:border-content/60"
            }`}
          >
            {todo.done ? <Check className="size-2.5" strokeWidth={3} /> : null}
          </button>
          {editing === index ? (
            <InlineInput
              initial={todo.text}
              ariaLabel="Todo text"
              commitOnBlur
              className="flex-1"
              onCommit={(newText) => {
                setEditing(null);
                if (newText !== todo.text) {
                  onEdit({
                    type: "renameTodo",
                    index,
                    text: todo.text,
                    newText,
                  });
                }
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                if (sortable.consumeClick()) return;
                setEditing(index);
              }}
              className={`min-w-0 flex-1 text-left text-[12px] leading-snug ${
                todo.done ? "text-content/40 line-through" : "text-content/80"
              }`}
            >
              {todo.text}
            </button>
          )}
          {disabled ? null : (
            <button
              type="button"
              aria-label={`Delete todo ${todo.text}`}
              onClick={() =>
                onEdit({ type: "removeTodo", index, text: todo.text })
              }
              className="grid size-4 shrink-0 place-items-center rounded text-content/30 opacity-0 hover:text-content group-hover/todo:opacity-100"
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          )}
        </div>
      ))}
      {disabled ? null : (
        <input
          value={draft}
          aria-label="Add todo"
          placeholder="Add a todo"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          className="ml-5 rounded bg-transparent px-1 py-0.5 text-[12px] text-content outline-none placeholder:text-content/30"
        />
      )}
    </div>
  );
}

function hasFiles(data: DataTransfer | null): data is DataTransfer {
  return !!data && [...data.types].includes("Files");
}

function DocumentEditor({ board, task }: { board: TaskBoard; task: Task }) {
  const [mode, setMode] = useMarkdownMode(`task:${task.id}`, "source");
  const [draft, setDraft] = useState(
    () => drafts.get(task.id) ?? task.document,
  );
  const [saving, setSaving] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = draft !== task.document;

  // Follow changes made elsewhere (Refresh, an agent) while nothing is unsaved.
  const lastDocument = useRef(task.document);
  useEffect(() => {
    if (draftRef.current === lastDocument.current) setDraft(task.document);
    lastDocument.current = task.document;
  }, [task.document]);

  useEffect(() => {
    if (dirty) drafts.set(task.id, draft);
    else drafts.delete(task.id);
  }, [dirty, draft, task.id]);

  const save = async () => {
    if (saving || task.readOnly) return;
    setSaving(true);
    const document = draftRef.current;
    const saved = await updateTask(taskRef.current, {
      type: "saveDocument",
      document,
    });
    setSaving(false);
    if (saved) {
      drafts.delete(taskRef.current.id);
      drafts.delete(saved.id);
      lastDocument.current = saved.document;
      if (draftRef.current === document) setDraft(saved.document);
    }
  };

  const addImages = async (load: () => Promise<TaskImagesResult>) => {
    const field = fieldRef.current;
    const start = field?.selectionStart ?? draftRef.current.length;
    const end = field?.selectionEnd ?? start;
    setImageBusy(true);
    try {
      const { images, task: next } = await load();
      const inserted = insertNoteImagesMarkdown(
        draftRef.current,
        start,
        end,
        images,
      );
      if (next.id !== taskRef.current.id) {
        // The image gave the file its id; the editor remounts under it with
        // the text that now references the image.
        drafts.delete(taskRef.current.id);
        drafts.set(next.id, inserted.value);
        replaceTask(taskRef.current, next);
        return;
      }
      setDraft(inserted.value);
      if (mode !== "source") setMode("source");
      requestAnimationFrame(() => {
        fieldRef.current?.focus();
        fieldRef.current?.setSelectionRange(inserted.cursor, inserted.cursor);
      });
    } catch (error) {
      showToast(taskErrorText(error), { tone: "error" });
    } finally {
      setImageBusy(false);
    }
  };

  const taskDir = `${board.root}/${task.path.split("/").slice(0, -1).join("/")}`;

  return (
    <div
      className="flex flex-col gap-2 border-t border-stroke p-3"
      onKeyDown={(event) => {
        const mod = IS_MAC ? event.metaKey : event.ctrlKey;
        if (mod && event.key.toLowerCase() === "s") {
          event.preventDefault();
          event.stopPropagation();
          void save();
        }
      }}
      onPaste={(event) => {
        if (task.readOnly || !hasFiles(event.clipboardData)) return;
        const files = [...event.clipboardData.files];
        if (files.length === 0) return;
        event.preventDefault();
        void addImages(() =>
          saveTaskImagesFromFiles(board.root, taskRef.current, files),
        );
      }}
      onDragOver={(event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFiles(event.dataTransfer) || task.readOnly) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFiles(event.dataTransfer) || task.readOnly) return;
        event.preventDefault();
        const files = [...event.dataTransfer.files];
        if (files.length) {
          void addImages(() =>
            saveTaskImagesFromFiles(board.root, taskRef.current, files),
          );
        }
      }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-content/45">
          Document
        </span>
        {dirty ? (
          <span className="text-[11px] text-amber-400">Unsaved</span>
        ) : null}
        {imageBusy ? (
          <span className="text-[11px] text-content/45">Adding images…</span>
        ) : null}
        <div className="flex-1" />
        <MarkdownModeToggle mode={mode} onChange={setMode} />
        <button
          type="button"
          disabled={!dirty || saving || task.readOnly}
          onClick={() => void save()}
          title={`Save (${IS_MAC ? "⌘" : "Ctrl+"}S)`}
          className="rounded-md bg-content px-2.5 py-0.5 text-[11px] font-medium text-background-base hover:bg-content/80 disabled:opacity-30"
        >
          Save
        </button>
      </div>
      {mode === "source" && !task.readOnly ? (
        <MarkdownSourceEditor
          textareaRef={fieldRef}
          value={draft}
          label="Task document"
          placeholder="Write notes, plans, and decisions in markdown"
          onChange={setDraft}
        />
      ) : draft.trim() ? (
        <div className="text-[13px]">
          <AgentMarkdown text={draft} cwd={taskDir} localMedia hardBreaks />
        </div>
      ) : (
        <p className="text-[12px] text-content/35">No document yet.</p>
      )}
    </div>
  );
}
