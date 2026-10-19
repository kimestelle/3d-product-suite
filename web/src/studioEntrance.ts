export type EntrancePhase = 'landing' | 'contracting' | 'waiting' | 'expanding' | 'studio';
export type EntranceState = {phase: EntrancePhase; progress: number; ready: boolean; error: string; attempt: number};
export type EntranceAction =
  | {type: 'start' | 'retry' | 'back' | 'direct'}
  | {type: 'ready'; attempt: number}
  | {type: 'failed'; attempt: number; message: string}
  | {type: 'advance'; phase: EntrancePhase; progress: number};

export const entranceState = (landing = true): EntranceState => ({phase: landing ? 'landing' : 'studio', progress: 0, ready: false, error: '', attempt: 0});
export const entranceEase = (value: number) => {const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t);};
export const LOADING_RADIUS = 46;

// Readiness and motion are separate gates. Fast loads still contract; slow loads
// hold the circle. An abandoned attempt can never open a later entry.
export function entranceReducer(state: EntranceState, action: EntranceAction): EntranceState {
  switch (action.type) {
    case 'start': return state.phase === 'landing' ? {...entranceState(), phase: 'contracting', attempt: state.attempt + 1} : state;
    case 'back': return {...entranceState(), attempt: state.attempt + 1};
    case 'direct': return {...entranceState(false), attempt: state.attempt + 1};
    case 'retry': return ['contracting', 'waiting'].includes(state.phase) ? {...state, ready: false, error: '', attempt: state.attempt + 1} : state;
    case 'ready':
      if (action.attempt !== state.attempt || state.error || !['contracting', 'waiting'].includes(state.phase)) return state;
      return {...state, ready: true, phase: state.phase === 'waiting' ? 'expanding' : state.phase, progress: state.phase === 'waiting' ? 0 : state.progress};
    case 'failed':
      if (action.attempt !== state.attempt || !['contracting', 'waiting'].includes(state.phase)) return state;
      return {...state, ready: false, error: action.message};
    case 'advance':
      if (state.phase !== action.phase || !['contracting', 'expanding'].includes(state.phase)) return state;
      if (action.progress < 1) return {...state, progress: Math.max(state.progress, action.progress)};
      return {...state, phase: state.phase === 'expanding' ? 'studio' : state.ready && !state.error ? 'expanding' : 'waiting', progress: 0};
  }
}

export type EntranceOrigin = {x: number; y: number; width: number; viewportWidth: number; viewportHeight: number; aperture: number};

export function editorEntranceClip(origin: EntranceOrigin, progress: number): string {
  const remaining = 1 - entranceEase(progress);
  const r = LOADING_RADIUS;
  return `inset(${(origin.y-r)*remaining}px ${(origin.viewportWidth-origin.x-r)*remaining}px ${(origin.viewportHeight-origin.y-r)*remaining}px ${(origin.x-r)*remaining}px round ${r*remaining}px)`;
}
