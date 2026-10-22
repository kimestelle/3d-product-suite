import type {EditorMode} from './navigation';
import './export-navigation.css';

const modes: EditorMode[] = ['still', 'video'];

/** Both Film and Export edit the same output mode, without a second local selection. */
export default function FilmModeTabs({mode, onMode}: {mode: EditorMode; onMode: (mode: EditorMode) => void}) {
  return <div className="gesso-film-mode-tabs" role="tablist" aria-label="Film format" aria-orientation="horizontal">
    {modes.map((value, index) => <button key={value} type="button" role="tab" data-mode={value}
      aria-selected={mode === value} tabIndex={mode === value ? 0 : -1} onClick={() => onMode(value)}
      onKeyDown={event => {
        // Native Space/Enter still activate the tab; neither should reach viewport playback.
        if (event.key === ' ' || event.key === 'Enter') event.stopPropagation();
        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % modes.length
          : event.key === 'ArrowLeft' ? (index + modes.length - 1) % modes.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? modes.length - 1 : null;
        if (nextIndex === null) return;
        event.preventDefault(); event.stopPropagation();
        const nextMode = modes[nextIndex];
        onMode(nextMode);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${nextMode}"]`)?.focus();
      }}>{value === 'still' ? 'Still' : 'Video'}</button>)}
  </div>;
}
