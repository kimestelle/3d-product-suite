import {useEffect, useRef, useState} from 'react';
import {LandingMediaWindow} from './LandingMediaWindow';
import {landingReelShotAt, LANDING_REEL_VERSION} from './landingReelMetadata';
import showcasePoster from './assets/gesso/landing-showcase-poster.webp?no-inline';
import studioPoster from './assets/gesso/studio-film-entry.webp?no-inline';
import {STATIC_MOTION_QUERY} from './motionPolicy';

type Film = 'studio' | 'reel';
type Phase = 'closed' | 'loading' | 'opening' | 'ready';
const studio = '/media/gesso-studio-editor.mp4';
const reel = '/media/gesso-landing-reel.mp4?v=' + LANDING_REEL_VERSION;
const mobileReel = '/media/gesso-landing-reel-mobile.mp4?v=' + LANDING_REEL_VERSION;
// This excerpt starts at 6.5s in the guide film, after the editor settles.
// Its first decoded frame supplies the poster; no seek or second image is needed.
const quietQuery = STATIC_MOTION_QUERY + ', (max-width: 899px)';

export default function LandingFilm({active,autoPlayOnReveal=false}:{active:boolean;autoPlayOnReveal?:boolean}) {
  const [film,setFilm] = useState<Film>('studio');
  const [phase,setPhase] = useState<Phase>('closed');
  const [failed,setFailed] = useState(false);
  const [shot,setShot] = useState(landingReelShotAt(0));
  const [saveData,setSaveData] = useState(false);
  const [reduced,setReduced] = useState(false);
  const [visible,setVisible] = useState(false);
  const [hidden,setHidden] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const requested = useRef<'manual' | 'automatic' | null>(null);
  const automaticAttempted = useRef(false);
  const automaticPlayback = useRef(false);
  const automaticAllowed = useRef(false);
  const playEpoch = useRef(0);
  const playbackWanted = useRef(false);
  const focusPlayer = useRef(false);
  const open = phase === 'opening' || phase === 'ready';

  useEffect(() => {
    const connection = (navigator as Navigator & {connection?: EventTarget & {saveData?:boolean}}).connection;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      const saving = Boolean(connection?.saveData);
      automaticAllowed.current = !motion.matches && !saving;
      setSaveData(saving);
      setReduced(motion.matches);
      if (!automaticAllowed.current && automaticPlayback.current) {
        playEpoch.current++;
        playbackWanted.current = false;
        requested.current = null;
        video.current?.pause();
        setPhase(value => value === 'loading' || value === 'opening' ? 'closed' : value);
      }
    };
    update();
    motion.addEventListener('change', update);
    connection?.addEventListener('change', update);
    return () => {
      motion.removeEventListener('change', update);
      connection?.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    const player = video.current;
    if (!player) return;
    const pause = () => {
      playEpoch.current++;
      playbackWanted.current = false;
      player.pause();
      requested.current = null;
      setPhase(value => value === 'loading' || value === 'opening' ? 'closed' : value);
    };
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(entry.isIntersecting);
      if (!entry.isIntersecting) {
        if (!document.hidden) automaticAttempted.current = false;
        pause();
      }
    });
    observer.observe(player);
    const pauseHidden = () => {
      setHidden(document.hidden);
      if (document.hidden) pause();
    };
    pauseHidden();
    document.addEventListener('visibilitychange', pauseHidden);
    return () => {
      playEpoch.current++;
      playbackWanted.current = false;
      player.pause();
      observer.disconnect();
      document.removeEventListener('visibilitychange', pauseHidden);
    };
  }, [film]);

  useEffect(() => {
    const player = video.current;
    if (!player) return;
    if (!active) {
      automaticAttempted.current = false;
      playEpoch.current++;
      playbackWanted.current = false;
      requested.current = null;
      player.pause();
      setPhase(value => value === 'loading' || value === 'opening' ? 'closed' : value);
      return;
    }
    if (!autoPlayOnReveal && automaticPlayback.current) {
      playEpoch.current++;
      playbackWanted.current = false;
      requested.current = null;
      player.pause();
      setPhase(value => value === 'loading' || value === 'opening' ? 'closed' : value);
      return;
    }
    if (!visible || hidden || !autoPlayOnReveal || reduced || saveData || failed || automaticAttempted.current) return;
    automaticAttempted.current = true;
    if (player.ended) return;
    automaticPlayback.current = true;
    requested.current = 'automatic';
    // Muting the live property as well as its attribute precedes play(),
    // including on re-entry. The existing playhead is retained.
    player.defaultMuted = true;
    player.muted = true;
    if (phase !== 'ready') setPhase(player.readyState >= 2 ? 'opening' : 'loading');
  }, [active,visible,hidden,autoPlayOnReveal,reduced,saveData,failed]);

  useEffect(() => {
    const player = video.current;
    if (!player || !active || !visible || hidden || !requested.current) return;
    if (requested.current === 'automatic' && !automaticAllowed.current) return;
    if (phase === 'loading') {
      if (!player.readyState || player.error) player.load();
      else if (player.readyState >= 2) setPhase('opening');
    }
    if (phase === 'ready' && requested.current) {
      const epoch = ++playEpoch.current;
      playbackWanted.current = true;
      requested.current = null;
      if (focusPlayer.current && document.activeElement === document.body) player.focus({preventScroll:true});
      focusPlayer.current = false;
      void player.play().then(() => {
        if (epoch !== playEpoch.current && (player !== video.current || !playbackWanted.current)) player.pause();
      }).catch(() => { /* Native play remains available after an autoplay rejection. */ });
    }
  }, [active,visible,hidden,phase,reduced,saveData]);

  useEffect(() => {
    if (phase !== 'opening') return;
    const motion = matchMedia(quietQuery);
    const connection = (navigator as Navigator & {connection?: EventTarget & {saveData?:boolean}}).connection;
    const complete = () => setPhase('ready');
    const quiet = () => {if (motion.matches || connection?.saveData) complete();};
    quiet();
    motion.addEventListener('change', quiet);
    connection?.addEventListener('change', quiet);
    // The native edge transition usually finishes first. This also resolves
    // an interrupted CSS transition or a preference changed during opening.
    const timeout = window.setTimeout(complete, 360);
    return () => {
      clearTimeout(timeout);
      motion.removeEventListener('change', quiet);
      connection?.removeEventListener('change', quiet);
    };
  }, [phase]);

  function choose(next:Film) {
    if (next === film) return;
    playEpoch.current++;
    playbackWanted.current = false;
    video.current?.pause();
    requested.current = null;
    automaticAttempted.current = true;
    automaticPlayback.current = false;
    setFailed(false);
    setShot(landingReelShotAt(0));
    setPhase(next === 'studio' ? 'closed' : 'ready');
    setFilm(next);
  }
  function play() {
    requested.current = 'manual';
    automaticPlayback.current = false;
    automaticAttempted.current = true;
    focusPlayer.current = document.activeElement === playButton.current;
    setFailed(false);
    setPhase('loading');
  }
  function reveal() {
    const player = video.current;
    if (phase === 'loading' && requested.current && player && player.readyState >= 2) {
      setPhase('opening');
    }
  }
  function fail() {
    playEpoch.current++;
    playbackWanted.current = false;
    requested.current = null;
    setFailed(true);
    setPhase(film === 'reel' ? 'ready' : 'closed');
  }

  return <figure className="public-film">
    <div className="public-film-stage" data-open={open} data-film={film} data-save-data={saveData}>
      <LandingMediaWindow data-film-window="" className="public-film-screen"
        onTransitionEnd={event => {
          if (event.target === event.currentTarget && event.propertyName === 'left' && phase === 'opening') setPhase('ready');
        }}>
        <div className="public-film-content">
          <video key={film} ref={video} controls={phase === 'ready'} tabIndex={phase === 'ready' ? 0 : -1} playsInline preload="none"
            poster={film === 'studio' ? studioPoster : showcasePoster} width="1280" height="720"
            aria-label={film === 'studio' ? 'Auden watch in the Film workspace and its rendered output' : 'Five product films made in Gesso'}
            onError={fail} onCanPlay={reveal}
            onPause={() => {playbackWanted.current = false;}}
            onPointerDown={() => {automaticPlayback.current = false; playbackWanted.current = true;}}
            onKeyDown={() => {automaticPlayback.current = false; playbackWanted.current = true;}}
            onTimeUpdate={event => {if (film === 'reel') setShot(landingReelShotAt(event.currentTarget.currentTime));}}>
            {film === 'reel' && <source src={mobileReel} media="(max-width: 760px)" type="video/mp4"/>}
            <source src={film === 'studio' ? studio : reel} type="video/mp4" onError={fail}/>
          </video>
        </div>
      </LandingMediaWindow>
    </div>
    <figcaption>
      {film === 'studio' && phase !== 'ready' ? <button ref={playButton} type="button" className="public-film-play" onClick={play}
        disabled={phase === 'loading' || phase === 'opening'}>
        {phase === 'loading' ? 'Loading film…' : phase === 'opening' ? 'Opening Film…' : failed ? 'Try the film again' : 'Watch the studio film'}
      </button> : film === 'reel' ? <span>{`${shot.product} · ${shot.world}`}</span> : null}
      {!autoPlayOnReveal && <span className="public-film-choice" role="group" aria-label="Choose a film">
        {(phase === 'ready' || film === 'reel') && <button type="button" aria-pressed={film === 'studio'} onClick={() => choose('studio')}>Studio film</button>}
        <button type="button" aria-pressed={film === 'reel'} onClick={() => choose('reel')}>Product reel</button>
      </span>}
    </figcaption>
    {failed && <p role="status">The film couldn’t play here. <a href={film === 'studio' ? studio : reel}>Open the MP4</a></p>}
  </figure>;
}
