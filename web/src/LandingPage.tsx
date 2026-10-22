import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import reelPoster from './assets/gesso/landing-showcase-poster.webp';
import watchStill from './assets/gesso/form-light-renders/omega-speedmaster.webp';
import navArrow from './assets/gesso/about-arrow-up-right.svg';
import {FrameWindow, useFrameSource, useFrameInvalidation} from './DynamicFrame';
import {landingFrameNodes} from './frameGeometry';
import {LandingReel, LANDING_REEL_STILL} from './landingReel';
import LandingVideoOverlay from './LandingVideoOverlay';
import type {EntranceOrigin} from './studioEntrance';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import './landing.css';
import './site-grid.css';

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const repeatability = 'Set up your product once. Generate infinite worlds and content.';

// Hover keeps one reversible timeline. Continuous geometry belongs to the shared
// frame renderer; only the entrance's semantic thresholds update React.
function useAperture(rootRef: RefObject<HTMLElement | null>, invalidate: () => void, active: boolean) {
  const windowRef = useRef<HTMLDivElement>(null);
  const [semantic, setSemantic] = useState({open: false, expanded: false});
  const semanticRef = useRef(semantic);
  const blocked = useRef(!active);
  const motion = useRef({hover: false, focus: false, pinned: false, reduced: false, progress: 0, target: 0, frame: 0, last: 0});
  const paint = useCallback((progress: number) => {
    const reveal = clamp((progress - .68) / .26);
    const style = rootRef.current?.style;
    style?.setProperty('--aperture-progress', String(progress));
    style?.setProperty('--entrance-reveal', String(reveal));
    style?.setProperty('--entrance-offset', `${(1 - reveal) * 8}px`);
    if (windowRef.current) windowRef.current.dataset.aperture = progress.toFixed(3);
    const next = {open: reveal > .9, expanded: progress === 1};
    if (next.open !== semanticRef.current.open || next.expanded !== semanticRef.current.expanded) {
      semanticRef.current = next;
      setSemantic(next);
    }
    invalidate();
  }, [rootRef, invalidate]);
  const drive = useCallback(() => {
    const m = motion.current;
    m.target = m.hover || m.focus || m.pinned ? 1 : 0;
    if (document.hidden || blocked.current) return;
    if (m.reduced) {
      cancelAnimationFrame(m.frame); m.frame = 0;
      m.progress = m.target; paint(m.progress); return;
    }
    if (m.frame || Math.abs(m.target - m.progress) < .001) return;
    m.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, Math.min(now - m.last, 48)); m.last = now;
      const delta = m.target - m.progress;
      // Reversing changes only direction; it never restarts the playhead.
      const step = dt / 600;
      m.progress += Math.sign(delta) * Math.min(Math.abs(delta), step);
      // Keep exact endpoints for the shared frame and its content clip.
      if (Math.abs(m.target - m.progress) < .001) m.progress = m.target;
      paint(m.progress);
      m.frame = Math.abs(m.target - m.progress) > .001 ? requestAnimationFrame(tick) : 0;
    };
    m.frame = requestAnimationFrame(tick);
  }, [paint]);
  useLayoutEffect(() => {
    blocked.current = !active;
    cancelAnimationFrame(motion.current.frame); motion.current.frame = 0;
    if (active) {paint(motion.current.progress); drive();}
    else Object.assign(motion.current, {hover: false, focus: false, pinned: false});
  }, [active, paint, drive]);
  useEffect(() => {
    const preference = matchMedia(STATIC_MOTION_QUERY);
    const changePreference = () => {motion.current.reduced = preference.matches; drive();};
    const visibility = () => {
      cancelAnimationFrame(motion.current.frame); motion.current.frame = 0;
      if (!document.hidden) drive();
    };
    changePreference();
    preference.addEventListener('change', changePreference);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(motion.current.frame); motion.current.frame = 0;
      preference.removeEventListener('change', changePreference);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [drive]);
  const readProgress = useCallback(() => motion.current.progress, []);
  return {windowRef, ...semantic, readProgress,
    hover: () => {motion.current.hover = true; drive();},
    leave: () => {motion.current.hover = false; motion.current.pinned = false; drive();},
    focus: (focused: boolean) => {motion.current.focus = focused; drive();},
    toggle: () => {motion.current.pinned = !motion.current.pinned; drive();},
    dismiss: () => {Object.assign(motion.current, {hover: false, focus: false, pinned: false}); drive();},
  };
}

function useLandingReel(active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const player = useRef<LandingReel | null>(null);
  const [state, setState] = useState(LANDING_REEL_STILL);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reel = new LandingReel(video, setState, !active);
    player.current = reel;
    return () => {reel.dispose(); player.current = null;};
  }, []);
  useEffect(() => player.current?.setEntering(!active), [active]);
  return {...state, videoRef, toggle: () => player.current?.toggle()};
}

export default function LandingPage({active}: {active:boolean}) {
  const id = useId().replace(/:/g, '');
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const invalidate = useFrameInvalidation();
  const invalidateLanding = useCallback(() => invalidate('landing'), [invalidate]);
  const aperture = useAperture(rootRef, invalidateLanding, active);
  const reel = useLandingReel(active);
  const stillRender = reel.failed || (!reel.wanted && !reel.frameReady) ? watchStill : reelPoster;
  const pointerKind = useRef('mouse');
  const frame = useRef<{origin:EntranceOrigin;ground:string;light:string}|null>(null);
  useFrameSource('landing', () => {
    if (!rootRef.current || !aperture.windowRef.current || !frame.current) return null;
    const {origin, ground, light} = frame.current;
    const scale = origin.width / 1000;
    return {nodes:landingFrameNodes({...origin, aperture:aperture.readProgress()}),ground,fill:light,
      halo:{color:light,blur:104*scale,spread:72*scale,opacity:1}};
  });
  useLayoutEffect(() => {
    const root = rootRef.current, window = aperture.windowRef.current;
    if (!root || !window) return;
    const measure = () => {
      const box = window.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const styles = getComputedStyle(root);
      frame.current = {origin:{x:box.left+box.width/2,y:box.top+box.height/2,width:box.width,
        viewportWidth:innerWidth,viewportHeight:innerHeight,aperture:aperture.readProgress()},
        ground:styles.getPropertyValue('--landing-surround').trim() || '#980101',
        light:styles.getPropertyValue('--landing-light').trim() || '#ff5724'};
      invalidateLanding();
    };
    const observer = new ResizeObserver(measure); observer.observe(window);
    globalThis.addEventListener('resize', measure);
    measure();
    return () => {observer.disconnect();globalThis.removeEventListener('resize', measure);};
  }, [active, aperture.windowRef, aperture.readProgress, invalidateLanding]);

  return <main ref={rootRef} inert={!active} aria-hidden={!active} className="gesso-landing" aria-label="gesso — your product, your world"
    onPointerDown={event=>{pointerKind.current=event.pointerType;if(event.pointerType==='touch'&&!aperture.windowRef.current?.contains(event.target as Node)) aperture.dismiss();}}>
    <div className="landing-topline gesso-site-header" data-frame-outside><a className="landing-mobile-home gesso-site-wordmark" href="/landing" aria-label="gesso home">gesso</a><nav className="gesso-site-nav" aria-label="Main navigation"><a className="landing-about-link site-about-link" href="/about">about</a><a className="landing-study-link site-study-link" href="/aperture">form + light</a><a className="landing-studio-link site-studio-link" data-studio-resume href="/?step=product&layer=model">enter studio <img src={navArrow} alt="" width="14" height="20"/></a></nav></div>

    <section className="landing-composition" aria-label="Your product, your world">
      <a className="landing-side landing-product" data-frame-outside href="/?step=product&layer=model"><span>your product</span></a>

      <div ref={aperture.windowRef} className={`landing-window ${ready || reel.frameReady ? 'is-ready' : ''} ${aperture.open ? 'is-open' : ''}`}
        data-aperture="0.000"
        onPointerEnter={event=>{if(active&&event.pointerType!=='touch') aperture.hover();}}
        onPointerLeave={event=>{if(active&&event.pointerType!=='touch') aperture.leave();}}
        onFocusCapture={event=>{if(active&&event.target.matches(':focus-visible')) aperture.focus(true);}}
        onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)) aperture.focus(false);}}
        onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.currentTarget.querySelector<HTMLButtonElement>('.landing-aperture-trigger')?.focus({preventScroll:true});aperture.dismiss();}}}
        onPointerDown={event=>{if(event.pointerType==='touch'&&!(event.target as Element).closest('a,button')) aperture.toggle();}}>
        <h1 className="landing-logo" data-frame-outside aria-label="gesso"><button className="landing-aperture-trigger" type="button" aria-label="Reveal studio entrance" aria-expanded={aperture.open} aria-controls={`${id}-enter`} onClick={event=>{if(event.detail===0) aperture.focus(true);else if(pointerKind.current==='touch') aperture.toggle();}}><span aria-hidden="true">gesso</span></button></h1>
        <FrameWindow className="landing-window-content" vignette>
          <img className="landing-render gesso-product-film" src={stillRender} alt="Chronograph fan art in the velvet jewel-box, rendered in gesso" onLoad={()=>setReady(true)} onError={()=>setFailed(true)}/>
          <video ref={reel.videoRef} className={`landing-video gesso-product-film ${reel.frameReady ? 'has-frame' : ''}`}
            poster={reelPoster} muted playsInline loop preload="none" disablePictureInPicture tabIndex={-1} aria-hidden="true"/>
          <LandingVideoOverlay visible={active && aperture.open} playing={reel.playing} failed={reel.failed} videoRef={reel.videoRef} onToggle={reel.toggle}/>
        </FrameWindow>
        <div id={`${id}-enter`} className="landing-entrance" data-frame-outside inert={!aperture.open}>
          <a className="landing-enter" data-studio-resume href="/?step=product&layer=model">enter studio <svg width="14.25" height="20" viewBox="0 0 14.25 20" fill="none" aria-hidden="true"><path d="M13.5 17V7H3.5M13.5 7L3.5 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg></a>
          <p className="landing-repeatability">{repeatability}</p>
        </div>
        {failed && !reel.frameReady && <p className="landing-image-error" role="status">The scene image couldn’t load. <button onClick={()=>location.reload()}>Reload</button></p>}
      </div>

      <a className="landing-side landing-world" data-frame-outside href="/?step=world&layer=environment"><span>your world</span></a>
    </section>

    <footer className="landing-footer" data-frame-outside>
      <p className="landing-repeatability landing-repeatability-compact" aria-hidden={!aperture.open}>{repeatability}</p>
      <span className="landing-caption">a reusable studio for product activation content</span>
      {reel.failed && <span className="landing-reel-status" role="status">Video unavailable. The still image is shown.</span>}
      <span className="landing-caption landing-credit">est. 2026</span>
    </footer>
  </main>;
}
