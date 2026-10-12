import { MessageSquare, X } from "../../../shared/ui/icons";
import {
  looksLikeProject,
  type RecentProject,
} from "../../projects/model/recents";
import { SearchableProjectPicker } from "../../projects/ui/SearchableProjectPicker";
import type { SessionSummary } from "../../sessions/data/sessionStore";
import { sessionDisplayTitle } from "../../sessions/model/session";
import { formatRelativeTime } from "../../inbox/model/githubTasks";
import type { Task } from "../model/tasks";
import { updateTask } from "../model/tasksStore";
import { defaultTaskProject, startTaskSession } from "../model/taskSession";

/**
 * The project a task's sessions run in, the sessions started from it, and
 * the button that starts another with the task as context.
 */
export function TaskSessionsField({
  task,
  recents,
  defaultCwd,
  sessions,
  onOpenSession,
}: {
  task: Task;
  recents: RecentProject[];
  defaultCwd?: string;
  sessions: readonly SessionSummary[];
  onOpenSession: (sessionId: string) => void;
}) {
  const fallback =
    defaultCwd && looksLikeProject(defaultCwd) ? defaultCwd : undefined;
  const project = defaultTaskProject(task, fallback);
  const readOnly = task.readOnly;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-content/45">Sessions</span>
      <div className="flex items-center gap-2">
        <SearchableProjectPicker
          cwd={project ?? "~"}
          recents={recents}
          mode="move"
          railCwd={defaultCwd}
          buttonClassName="px-1.5"
          onSelectProject={(path) => {
            if (!readOnly)
              void updateTask(task, { type: "setProject", project: path });
          }}
        />
        <div className="flex-1" />
        <button
          type="button"
          disabled={!project}
          title={
            project
              ? "Start a session with this task as context"
              : "Choose a project first"
          }
          onClick={() => project && startTaskSession(task, project)}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-content/15 px-2 py-0.5 text-[12px] text-content/80 hover:bg-content/5 disabled:opacity-40"
        >
          <MessageSquare className="size-3.5" strokeWidth={1.75} />
          Start session
        </button>
      </div>
      {task.sessions.map((id) => {
        const summary = sessions.find((session) => session.id === id);
        return (
          <div
            key={id}
            className="group/session flex min-w-0 items-center gap-1"
          >
            {summary ? (
              <button
                type="button"
                onClick={() => onOpenSession(id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-content/75 hover:bg-content/5 hover:text-content"
              >
                <span className="min-w-0 flex-1 truncate">
                  {sessionDisplayTitle(summary.title, summary.harness)}
                </span>
                <span className="shrink-0 text-[11px] text-content/35">
                  {formatRelativeTime(
                    new Date(summary.updatedAt).toISOString(),
                  )}
                </span>
              </button>
            ) : (
              <span
                className="min-w-0 flex-1 truncate px-1 py-0.5 text-[12px] text-content/35"
                title={id}
              >
                Session not found on this device
              </span>
            )}
            {readOnly ? null : (
              <button
                type="button"
                aria-label="Unlink session"
                onClick={() =>
                  void updateTask(task, {
                    type: "removeSession",
                    sessionId: id,
                  })
                }
                className="grid size-4 shrink-0 place-items-center rounded text-content/30 opacity-0 hover:text-content group-hover/session:opacity-100"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
