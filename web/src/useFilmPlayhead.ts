import {useCallback, useReducer, type SetStateAction} from 'react';

export type FilmPlayheadState = {frame: number; editingFrame: number};
export type FilmPlayheadAction =
  | {type: 'seek' | 'playback'; frame: SetStateAction<number>}
  | {type: 'restore-editing'};

/** Playback advances the image without changing the frame selected for editing. */
export function filmPlayheadReducer(state: FilmPlayheadState, action: FilmPlayheadAction): FilmPlayheadState {
  if (action.type === 'restore-editing')
    return state.frame === state.editingFrame ? state : {...state, frame: state.editingFrame};
  const frame = typeof action.frame === 'function' ? action.frame(state.frame) : action.frame;
  const editingFrame = action.type === 'seek' ? frame : state.editingFrame;
  return frame === state.frame && editingFrame === state.editingFrame ? state : {frame, editingFrame};
}

/** One renderer frame, with the last deliberate seek retained for returning to edit. */
export function useFilmPlayhead(initialFrame = 1) {
  const [state, dispatch] = useReducer(filmPlayheadReducer, initialFrame, frame => ({frame, editingFrame: frame}));
  const setFrame = useCallback((frame: SetStateAction<number>) => dispatch({type: 'seek', frame}), []);
  const setPlaybackFrame = useCallback((frame: SetStateAction<number>) => dispatch({type: 'playback', frame}), []);
  const restoreEditingFrame = useCallback(() => dispatch({type: 'restore-editing'}), []);
  return {...state, setFrame, setPlaybackFrame, restoreEditingFrame};
}
