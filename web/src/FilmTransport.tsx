import './film-transport.css';

/** Film and its export preview operate the same clock. */
export function FilmTransport({playing,disabled=false,atStart,atEnd,onPlay,onStart,onEnd,context='film'}:{
  playing:boolean;disabled?:boolean;atStart:boolean;atEnd:boolean;
  onPlay?:()=>void;onStart:()=>void;onEnd:()=>void;context?:'film'|'export preview';
}) {
  return <div className="film-transport" role="group" aria-label={`${context === 'film' ? 'Film' : 'Export preview'} playback controls`}
    onKeyDown={event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();}}>
    <button type="button" aria-label={`Go to start of ${context}`} title="Go to start" disabled={disabled||atStart&&!playing} onClick={onStart}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 20 9 12l10-8v16Z"/><path d="M5 19V5"/></svg>
    </button>
    <button type="button" className="film-play" aria-label={`${playing?'Pause':'Play'} ${context}`} title={`${playing?'Pause':'Play'} · Space`} aria-pressed={playing} disabled={disabled||!onPlay} onClick={onPlay}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playing?<><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>:<path d="M7 4.5a1 1 0 0 1 1.5-.86l12 7.5a1 1 0 0 1 0 1.72l-12 7.5A1 1 0 0 1 7 19.5Z"/>}</svg>
    </button>
    <button type="button" aria-label={`Go to end of ${context}`} title="Go to end" disabled={disabled||atEnd&&!playing} onClick={onEnd}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 4 10 8-10 8V4Z"/><path d="M19 5v14"/></svg>
    </button>
  </div>;
}
