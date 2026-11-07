import {UiIcon} from './UiIcon';
import './film-transport.css';

/** Film and its export preview operate the same clock. */
export function FilmTransport({playing,disabled=false,atStart,atEnd,onPlay,onStart,onEnd,context='film'}:{
  playing:boolean;disabled?:boolean;atStart:boolean;atEnd:boolean;
  onPlay?:()=>void;onStart:()=>void;onEnd:()=>void;context?:'film'|'export preview';
}) {
  return <div className="film-transport" role="group" aria-label={`${context === 'film' ? 'Film' : 'Export preview'} playback controls`}
    onKeyDown={event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();}}>
    <button type="button" aria-label={`Go to start of ${context}`} title="Go to start" disabled={disabled||atStart&&!playing} onClick={onStart}>
      <UiIcon name="skipBack" size={20}/>
    </button>
    <button type="button" className="film-play" aria-label={`${playing?'Pause':'Play'} ${context}`} title={`${playing?'Pause':'Play'} · Space`} aria-pressed={playing} disabled={disabled||!onPlay} onClick={onPlay}>
      <UiIcon name={playing ? "pause" : "play"} size={20}/>
    </button>
    <button type="button" aria-label={`Go to end of ${context}`} title="Go to end" disabled={disabled||atEnd&&!playing} onClick={onEnd}>
      <UiIcon name="skipForward" size={20}/>
    </button>
  </div>;
}
