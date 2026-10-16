/** Immutable undo history for JSON scene documents. */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: snapshot(initial), future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

/** Applying a new edit after undo discards the abandoned future branch. */
export function commitHistory<T>(history: History<T>, next: T, limit = 80): History<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('History limit must be a positive integer');
  }
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  return {
    past: [...history.past, snapshot(history.present)].slice(-limit),
    present: snapshot(next),
    future: [],
  };
}

export function undoHistory<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  return {
    past: history.past.slice(0, -1),
    present: snapshot(history.past[history.past.length - 1]),
    future: [snapshot(history.present), ...history.future],
  };
}

export function redoHistory<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  return {
    past: [...history.past, snapshot(history.present)],
    present: snapshot(history.future[0]),
    future: history.future.slice(1),
  };
}
