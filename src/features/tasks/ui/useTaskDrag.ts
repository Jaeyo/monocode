import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { setGrabbing, suppressTextSelection } from "../../../shared/lib/drag";
import type { TaskColumn } from "../model/tasks";

const THRESHOLD = 5;
const EDGE = 40;
const EDGE_STEP = 14;

export type TaskDropTarget = { column: string; index: number };

type DragState = {
  taskId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  target: TaskDropTarget | null;
};

/**
 * Drags a task card within its column or into another one. Columns register
 * their whole section, so dropping on a collapsed column's header puts the
 * task first in it.
 */
export function useTaskDrag(options: {
  columns: TaskColumn[];
  collapsed: (column: string) => boolean;
  scroller: () => HTMLElement | null;
  onDrop: (taskId: string, target: TaskDropTarget) => void;
}) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const columnNodes = useRef(new Map<string, HTMLElement>());
  const cardNodes = useRef(new Map<string, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  const suppressClickUntil = useRef(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [target, setTarget] = useState<TaskDropTarget | null>(null);

  const setColumnRef = useCallback((name: string, el: HTMLElement | null) => {
    if (el) columnNodes.current.set(name, el);
    else columnNodes.current.delete(name);
  }, []);

  const setCardRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardNodes.current.set(id, el);
    else cardNodes.current.delete(id);
  }, []);

  const targetAt = useCallback(
    (taskId: string, y: number): TaskDropTarget | null => {
      for (const column of optionsRef.current.columns) {
        const rect = columnNodes.current
          .get(column.name)
          ?.getBoundingClientRect();
        if (!rect || y < rect.top || y > rect.bottom) continue;
        if (optionsRef.current.collapsed(column.name)) {
          return { column: column.name, index: 0 };
        }
        let index = 0;
        for (const task of column.tasks) {
          if (task.id === taskId) continue;
          const card = cardNodes.current.get(task.id)?.getBoundingClientRect();
          if (card && y > card.top + card.height / 2) index++;
        }
        return { column: column.name, index };
      }
      return null;
    },
    [],
  );

  const onCardPointerDown = useCallback(
    (taskId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement | null)?.closest("[data-no-drag]"))
        return;
      const handle = event.currentTarget;
      const state: DragState = {
        taskId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        target: null,
      };
      drag.current = state;
      let restoreSelection: (() => void) | null = null;

      const onMove = (ev: PointerEvent) => {
        const current = drag.current;
        if (!current || current.taskId !== taskId) return;
        if (!current.active) {
          if (
            Math.hypot(
              ev.clientX - current.startX,
              ev.clientY - current.startY,
            ) < THRESHOLD
          ) {
            return;
          }
          current.active = true;
          try {
            handle.setPointerCapture(current.pointerId);
          } catch {
            /* the pointer already left */
          }
          restoreSelection = suppressTextSelection();
          setGrabbing(true);
          setDraggingId(taskId);
        }
        const scroller = optionsRef.current.scroller();
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          if (ev.clientY < rect.top + EDGE) scroller.scrollTop -= EDGE_STEP;
          else if (ev.clientY > rect.bottom - EDGE)
            scroller.scrollTop += EDGE_STEP;
        }
        const next = targetAt(taskId, ev.clientY) ?? current.target;
        if (
          next?.column === current.target?.column &&
          next?.index === current.target?.index
        ) {
          return;
        }
        current.target = next;
        setTarget(next);
      };

      const onUp = () => stop(true);
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        stop(false);
      };

      function stop(commit: boolean) {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        window.removeEventListener("keydown", onKey, true);
        const current = drag.current;
        drag.current = null;
        restoreSelection?.();
        setGrabbing(false);
        setDraggingId(null);
        setTarget(null);
        try {
          handle.releasePointerCapture(state.pointerId);
        } catch {
          /* already released */
        }
        if (!current?.active) return;
        suppressClickUntil.current = performance.now() + 400;
        if (commit && current.target) {
          optionsRef.current.onDrop(current.taskId, current.target);
        }
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      // Capture, so Escape cancels the drag before it closes the view.
      window.addEventListener("keydown", onKey, true);
    },
    [targetAt],
  );

  const consumeClick = useCallback(
    () => performance.now() < suppressClickUntil.current,
    [],
  );

  return {
    draggingId,
    target: draggingId ? target : null,
    setColumnRef,
    setCardRef,
    onCardPointerDown,
    consumeClick,
  };
}
