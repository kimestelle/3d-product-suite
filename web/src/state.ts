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

/** Scene objects may return from disk with their keys in a different order. */
export function equalJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value,index) => equalJson(value,b[index]));
  }
  const left = a as Record<string,unknown>, right = b as Record<string,unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right,key) && equalJson(left[key],right[key]));
}

/** Applying a new edit after undo discards the abandoned future branch. */
export function commitHistory<T>(history: History<T>, next: T, limit = 80): History<T> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('History limit must be a positive integer');
  }
  if (equalJson(history.present, next)) return history;
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
