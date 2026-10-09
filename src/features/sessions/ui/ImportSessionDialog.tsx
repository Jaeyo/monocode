import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  findExternalSession,
  listExternalSessions,
  type ExternalSession,
} from "../../../platform/tauri/externalSessions";
import { Modal } from "../../../shared/ui/Modal";
import { formatRelativeTime } from "../../inbox/model/githubTasks";
import { providerAccounts } from "../../providers/model/providerAccounts";
import {
  externalSessionPlacement,
  importedSessionTitle,
  isExternalSessionActive,
  projectSessionPaths,
  type ProjectCheckout,
} from "../model/externalImport";
import { HARNESS_LABEL } from "../model/session";
import { HarnessIcon } from "./HarnessIcon";

const accountIds = (provider: "claude" | "codex") =>
  providerAccounts(provider).map((account) => account.id);

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function ImportSessionDialog({
  projectRoot,
  worktrees,
  ownedSessions,
  onImport,
  onOpenExisting,
  onClose,
}: {
  projectRoot: string;
  worktrees: readonly ProjectCheckout[];
  /** Provider conversation id → MonoCode session id. */
  ownedSessions: ReadonlyMap<string, string>;
  onImport: (session: ExternalSession) => Promise<void>;
  onOpenExisting: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<ExternalSession[] | null>(null);
  const [listError, setListError] = useState("");
  const [showOwned, setShowOwned] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** A recently written session waiting for "Import anyway". */
  const [confirm, setConfirm] = useState<ExternalSession | null>(null);

  const paths = useMemo(
    () => projectSessionPaths(projectRoot, worktrees),
    [projectRoot, worktrees],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listExternalSessions("claude", accountIds("claude"), paths),
      listExternalSessions("codex", accountIds("codex"), paths),
    ])
      .then(([claude, codex]) => {
        if (cancelled) return;
        setSessions(
          [...claude, ...codex].sort((a, b) => b.updatedAt - a.updatedAt),
        );
      })
      .catch((reason) => {
        if (!cancelled) setListError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [paths]);

  const visible = (sessions ?? []).filter(
    (session) => showOwned || !ownedSessions.has(session.id),
  );
  const hiddenCount = (sessions?.length ?? 0) - visible.length;

  const choose = async (session: ExternalSession, confirmed = false) => {
    if (busy) return;
    setError("");
    const existing = ownedSessions.get(session.id);
    if (existing) {
      onOpenExisting(existing);
      return;
    }
    if (!confirmed && isExternalSessionActive(session.updatedAt)) {
      setConfirm(session);
      return;
    }
    setConfirm(null);
    setBusy(true);
    try {
      await onImport(session);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const submitId = async (event: FormEvent) => {
    event.preventDefault();
    const id = sessionId.trim();
    if (!id || busy) return;
    setError("");
    setConfirm(null);
    let found: ExternalSession[];
    try {
      found = await findExternalSession(
        id,
        accountIds("claude"),
        accountIds("codex"),
      );
    } catch (reason) {
      setError(errorText(reason));
      return;
    }
    if (found.length === 0) {
      setError("No Claude Code or Codex session has this ID.");
      return;
    }
    const inProject = found.find(
      (session) =>
        externalSessionPlacement(session.cwd, projectRoot, worktrees) !== null,
    );
    if (!inProject) {
      setError(
        `This session was started in ${found[0].cwd}. Open that project to import it.`,
      );
      return;
    }
    await choose(inProject);
  };

  return (
    <Modal
      title="Import CLI session"
      description="Continue a Claude Code or Codex session started outside MonoCode."
      size="md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-3 p-4 text-[12px]">
        <form onSubmit={submitId} className="flex gap-2">
          <input
            autoFocus
            value={sessionId}
            aria-label="Session ID"
            aria-invalid={error ? true : undefined}
            placeholder="Paste a session ID"
            spellCheck={false}
            onChange={(event) => {
              setSessionId(event.target.value);
              if (error) setError("");
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-content/10 bg-content/5 px-2.5 font-mono text-[12px] text-content outline-none placeholder:font-sans placeholder:text-content/30 focus:border-content/30"
          />
          <button
            type="submit"
            disabled={busy || !sessionId.trim()}
            className="rounded-md bg-accent px-3 font-medium text-white hover:brightness-110 active:scale-[0.97] disabled:opacity-50"
          >
            Import
          </button>
        </form>

        {error ? (
          <p role="alert" className="text-[11px] text-red-400">
            {error}
          </p>
        ) : null}

        {confirm ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-[11px] text-content/80"
          >
            <span className="min-w-0 flex-1">
              This session changed in the last two minutes and may still be
              open in a terminal. Close the CLI first so both don’t write to
              it.
            </span>
            <button
              type="button"
              onClick={() => void choose(confirm, true)}
              className="shrink-0 rounded-md px-2 py-1 font-medium hover:bg-content/8"
            >
              Import anyway
            </button>
          </div>
        ) : null}

        <div className="flex items-center justify-between text-[11px] text-content/50">
          <span>Sessions started in this project</span>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={showOwned}
              onChange={(event) => setShowOwned(event.target.checked)}
            />
            Include sessions already in MonoCode
          </label>
        </div>

        <div
          role="listbox"
          aria-label="CLI sessions"
          aria-busy={busy || sessions === null}
          className="max-h-[min(360px,50vh)] min-h-24 overflow-y-auto rounded-md border border-content/10"
        >
          {listError ? (
            <p className="p-3 text-red-400">{listError}</p>
          ) : sessions === null ? (
            <p className="p-3 text-content/45">Looking for sessions…</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-content/45">
              {hiddenCount > 0
                ? "Every session here is already in MonoCode."
                : "No Claude Code or Codex sessions were started in this project."}
            </p>
          ) : (
            visible.map((session) => {
              const owned = ownedSessions.has(session.id);
              const title =
                importedSessionTitle(session) ?? HARNESS_LABEL[session.provider];
              const worktree =
                externalSessionPlacement(session.cwd, projectRoot, worktrees)
                  ?.worktreeCwd;
              return (
                <button
                  key={`${session.provider}:${session.accountId}:${session.id}`}
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={busy}
                  onClick={() => void choose(session)}
                  className="flex w-full items-start gap-2 border-b border-content/5 px-2.5 py-2 text-left last:border-b-0 hover:bg-content/5 disabled:opacity-50"
                >
                  <HarnessIcon
                    harness={session.provider}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[13px] text-content">
                      {title}
                    </span>
                    <span className="truncate text-[11px] text-content/45">
                      {[
                        formatRelativeTime(
                          new Date(session.updatedAt).toISOString(),
                        ),
                        worktree ? `worktree ${worktree}` : null,
                        session.accountId !== "default"
                          ? `account ${session.accountId}`
                          : null,
                        owned ? "in MonoCode" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
