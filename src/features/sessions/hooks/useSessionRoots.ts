import { useEffect, useState } from "react";
import {
  sessionCheckpointRoots,
  subscribeReviewChanged,
} from "../model/checkpoint";

const NONE: string[] = [];

/**
 * External Git repositories a session has edited outside its cwd. Refreshes
 * whenever that session's review changes, which is when new edits land.
 */
export function useSessionRoots(sessionId: string | undefined): string[] {
  const [roots, setRoots] = useState<{ sessionId?: string; list: string[] }>({
    list: NONE,
  });

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      void sessionCheckpointRoots(sessionId)
        .then((list) => {
          if (disposed || current !== generation) return;
          setRoots((previous) =>
            previous.sessionId === sessionId &&
            previous.list.length === list.length &&
            previous.list.every((root, index) => root === list[index])
              ? previous
              : { sessionId, list },
          );
        })
        .catch(() => undefined);
    };
    load();
    const unsubscribe = subscribeReviewChanged((changed) => {
      if (!changed || changed === sessionId) load();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [sessionId]);

  return sessionId && roots.sessionId === sessionId ? roots.list : NONE;
}
