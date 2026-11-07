import {useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref} from 'react';
import {LandingMediaWindow} from './LandingMediaWindow';
import {useFrameInvalidation} from './DynamicFrame';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import {campaignField} from './campaign-geometry/campaign-geometry';
import {getWorldGeometry} from './campaign-geometry/nested-geometry';
import './landing-projection.css';

export type ProjectionScene = {src:string; label:string; tone:string};
export type ProjectionMotion = {setOpening:(opening:number)=>void};

const artWidth = 1000;
const inset = 32;
const cornerFraction = 24 / 440; // windows-square in the native curve presets
const square = getWorldGeometry('square');
const sectionRatio = square.minimumRadius / square.bounds.width;
const openingStops = [[16, .36], [32, .29], [64, .23], [128, .18]] as const;
const reachChange = .03;
type LayoutDimensions = {side:number; farLeft:number; productRadius:number; originX:number; originY:number};

function opticalOpening(radius:number, displayScale:number) {
  const displayed = radius * displayScale;
  for (let i = 1; i < openingStops.length; i++) {
    const [low, from] = openingStops[i - 1];
    const [high, to] = openingStops[i];
    if (displayed <= high) {
      const t = Math.max(0, (displayed - low) / (high - low));
      return radius * (1 + from + (to - from) * t);
    }
  }
  return radius * 1.18;
}

function sectionAtPose(layout:LayoutDimensions, pose:number, opening?:number) {
  const reach = opening ?? (1 + reachChange * pose);
  const nearRadius = layout.productRadius * 135 / 74;
  const radius = nearRadius + (layout.side * sectionRatio - nearRadius) * reach;
  const side = radius / sectionRatio;
  const centerX = layout.originX + (layout.farLeft + layout.side / 2 - layout.originX) * reach;
  const centerY = layout.originY + (inset + layout.side / 2 - layout.originY) * reach;
  return {reach, side, centerX, centerY, left:centerX - side / 2, top:centerY - side / 2};
}

function projectionLayout(displayWidth:number) {
  // The photograph owns the upper-right corner. The product origin sits
  // lower in the available left space, so the field rises toward the watch.
  const wide = Math.max(0, Math.min(1, (displayWidth - 400) / 750));
  const side = artWidth * (.72 - .11 * wide);
  const height = side + 2 * inset;
  const nearSide = artWidth * (.13 + .018 * wide);
  const farLeft = artWidth - side - inset;
  const originX = inset + nearSide / 2;
  const originY = inset + side * (.88 - .04 * wide);
  const productRadius = nearSide * sectionRatio * 74 / 135;
  const dimensions = {side, height, farLeft, productRadius, originX, originY};
  const native = campaignField({shape:'square', cx:originX, cy:originY,
    targetX:farLeft + side / 2, targetY:inset + side / 2,
    productRadius, farRadius:side * sectionRatio});
  const first = sectionAtPose(dimensions, -1);
  const last = sectionAtPose(dimensions, 1);
  const left = Math.min(first.left, last.left);
  const top = Math.min(first.top, last.top);
  const right = Math.max(first.left + first.side, last.left + last.side);
  const bottom = Math.max(first.top + first.side, last.top + last.side);
  const photoSide = Math.max(right - left, bottom - top);
  return {...dimensions, native,
    photo:{left:(left + right - photoSide) / 2, top:(top + bottom - photoSide) / 2, side:photoSide},
    opening:opticalOpening(productRadius, displayWidth / artWidth)};
}

const initialLayout = projectionLayout(750);
const quietQuery = STATIC_MOTION_QUERY + ', (pointer: coarse)';
type MotionController = {sync:()=>void; imageReady:(ready:boolean)=>void; paint:()=>void};

function WorldImage({scene, onError, onReady}:{scene:ProjectionScene; onError?:()=>void; onReady:(ready:boolean)=>void}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  if (failed) return <div className="landing-projection-failure" role="status">
    <span>This scene could not load.</span>
    {!onError && <button type="button" onClick={() => {setAttempt(n => n + 1); setFailed(false);}}>Retry</button>}
  </div>;
  const src = attempt ? `${scene.src}${scene.src.includes('?') ? '&' : '?'}retry=${attempt}` : scene.src;
  return <img className="landing-projection-photo" alt={scene.label} src={src}
    width={960} height={960} fetchPriority="high"
    onLoad={() => onReady(true)}
    onError={() => {setFailed(true); onReady(false); onError?.();}}/>;
}

export function LandingProjection({scene, onError, active=true, motionRef}:{scene:ProjectionScene; onError?:()=>void; active?:boolean; motionRef?:Ref<ProjectionMotion>}) {
  const artwork = useRef<HTMLElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const nearField = useRef<SVGPathElement>(null);
  const bridge = useRef<SVGPolygonElement>(null);
  const farField = useRef<SVGPathElement>(null);
  const mask = useRef<SVGMaskElement>(null);
  const maskGround = useRef<SVGRectElement>(null);
  const clearance = useRef<SVGCircleElement>(null);
  const origin = useRef<SVGCircleElement>(null);
  const plate = useRef<HTMLDivElement>(null);
  const enabled = useRef(active);
  const scrollOpening = useRef<number | undefined>(motionRef ? 1 : undefined);
  const controller = useRef<MotionController | null>(null);
  const invalidate = useFrameInvalidation();
  const opening = useId().replace(/:/g, '');
  enabled.current = active;
  useImperativeHandle(motionRef, () => ({setOpening(value) {
    const next=Math.max(0,Math.min(1,Number.isFinite(value)?value:1));
    if(scrollOpening.current===next)return;
    scrollOpening.current=next;
    controller.current?.paint();
  }}), []);

  useLayoutEffect(() => {
    const element = artwork.current;
    if (!element) return;
    const measuredFace = element.querySelector<HTMLElement>('[data-projection-end]');
    const contact = element.closest<HTMLElement>('.public-world-study') ?? element;
    if (!measuredFace) return;
    const face = measuredFace;
    const preference = matchMedia(quietQuery);
    const connection = (navigator as Navigator & {connection?: EventTarget & {saveData?:boolean}}).connection;
    let layout = initialLayout;
    let displayWidth = 750;
    let pose = 0;
    let target = 0;
    let frame = 0;
    let entered = false;
    let visible = false;
    let hovered = false;
    let focused = false;
    let measured = false;
    let photoReady = false;

    function paint() {
      const scale = displayWidth / artWidth;
      const {side, centerX, centerY, left, top, reach} = sectionAtPose(layout, pose, scrollOpening.current);
      // The native solver fixes the two common supports at this width. Vary
      // center separation and (far radius − near radius) by the same ratio:
      // each far contact then moves on its exact original support line.
      const contacts = layout.native.tangents;
      const farContacts = contacts.map(({near, far}) => ({
        x:near.x + (far.x - near.x) * reach,
        y:near.y + (far.y - near.y) * reach,
      }));
      bridge.current?.setAttribute('points', [contacts[0].near, contacts[1].near, farContacts[1], farContacts[0]]
        .map(point => `${point.x},${point.y}`).join(' '));
      farField.current?.setAttribute('transform', `translate(${centerX} ${centerY}) scale(${side / square.bounds.width}) translate(-500 -300)`);
      face.style.left = `${left * scale}px`;
      face.style.top = `${top * scale}px`;
      face.style.width = `${side * scale}px`;
      face.style.height = `${side * scale}px`;
      face.style.borderRadius = `${side * scale * cornerFraction}px`;
      // At compact the field is the near square, not a thumbnail. Keep the
      // circular clearance empty even when the far aperture crosses it.
      face.style.maskImage = `radial-gradient(circle ${layout.opening*scale}px at ${(layout.originX-left)*scale}px ${(layout.originY-top)*scale}px, transparent calc(100% - .25px), #000 100%)`;
      face.dataset.projectionClosed=String(reach===0);
      // The photo covers both endpoints once. The aperture's movement
      // is exactly cancelled here, so case, crown and shadows never drift.
      if (plate.current) {
        plate.current.style.left = `${(layout.photo.left - left) * scale}px`;
        plate.current.style.top = `${(layout.photo.top - top) * scale}px`;
        plate.current.style.width = `${layout.photo.side * scale}px`;
        plate.current.style.height = `${layout.photo.side * scale}px`;
      }
      element!.dataset.projectionPose = pose.toFixed(4);
      element!.dataset.projectionReach = String(reach);
      invalidate('landing');
    }

    function settle() {
      cancelAnimationFrame(frame);
      frame = 0;
      target = 0;
      pose = 0;
      paint();
    }

    function animate(next:number, duration:number) {
      if (target === next && frame) return;
      cancelAnimationFrame(frame);
      frame = 0;
      target = next;
      if (Math.abs(pose - next) < .0001) return;
      const from = pose;
      let last = performance.now();
      let elapsed = 0;
      function tick(now:number) {
        elapsed += Math.max(0, Math.min(now - last, 48));
        last = now;
        const amount = Math.min(1, elapsed / duration);
        const eased = 1 - Math.pow(1 - amount, 3);
        pose = from + (next - from) * eased;
        paint();
        frame = amount < 1 ? requestAnimationFrame(tick) : 0;
      }
      frame = requestAnimationFrame(tick);
    }

    function sync() {
      if(scrollOpening.current!==undefined){settle();return;}
      const shown = enabled.current && visible && photoReady && !document.hidden;
      if (!shown || preference.matches || connection?.saveData) {
        if (shown) entered = true;
        else {hovered = false; focused = false;}
        settle();
        return;
      }
      if (!entered) {
        entered = true;
        pose = -1;
        paint();
        animate(0, 420);
        return;
      }
      animate(hovered || focused ? 1 : 0, hovered || focused ? 240 : 180);
    }

    const measure = () => {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0) return;
      if (measured && Math.abs(displayWidth - bounds.width) < .01) return;
      measured = true;
      displayWidth = bounds.width;
      layout = projectionLayout(displayWidth);
      nearField.current?.setAttribute('d', layout.native.nearPath);
      nearField.current?.setAttribute('transform', layout.native.transform);
      element.style.aspectRatio = `${artWidth} / ${layout.height}`;
      svg.current?.setAttribute('viewBox', `0 0 ${artWidth} ${layout.height}`);
      mask.current?.setAttribute('height', String(layout.height));
      maskGround.current?.setAttribute('height', String(layout.height));
      clearance.current?.setAttribute('cx', String(layout.originX));
      clearance.current?.setAttribute('cy', String(layout.originY));
      clearance.current?.setAttribute('r', String(layout.opening));
      origin.current?.setAttribute('cx', String(layout.originX));
      origin.current?.setAttribute('cy', String(layout.originY));
      origin.current?.setAttribute('r', String(layout.productRadius));
      paint();
    };
    measure();
    sync();
    controller.current = {sync, paint, imageReady:(ready) => {photoReady = ready; sync();}};
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const intersection = new IntersectionObserver(([entry]) => {visible = entry.isIntersecting; sync();});
    intersection.observe(element);
    const enter = (event:PointerEvent) => {if (event.pointerType !== 'touch') {hovered = true; sync();}};
    const leave = () => {hovered = false; sync();};
    const focus = (event:FocusEvent) => {focused = event.target instanceof Element && event.target.matches(':focus-visible'); sync();};
    const blur = (event:FocusEvent) => {if (!(event.relatedTarget instanceof Node) || !contact.contains(event.relatedTarget)) {focused = false; sync();}};
    contact.addEventListener('pointerenter', enter);
    contact.addEventListener('pointerleave', leave);
    contact.addEventListener('focusin', focus);
    contact.addEventListener('focusout', blur);
    preference.addEventListener('change', sync);
    connection?.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      cancelAnimationFrame(frame);
      controller.current = null;
      resize.disconnect();
      intersection.disconnect();
      contact.removeEventListener('pointerenter', enter);
      contact.removeEventListener('pointerleave', leave);
      contact.removeEventListener('focusin', focus);
      contact.removeEventListener('focusout', blur);
      preference.removeEventListener('change', sync);
      connection?.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [invalidate]);
  useLayoutEffect(() => {controller.current?.sync();}, [active]);

  return <figure ref={artwork} className="landing-projection" style={{aspectRatio:`${artWidth} / ${initialLayout.height}`}}>
    <svg ref={svg} className="landing-projection-throw" viewBox={`0 0 ${artWidth} ${initialLayout.height}`} aria-hidden="true">
      <defs>
        <mask ref={mask} id={opening} maskUnits="userSpaceOnUse" x={0} y={0} width={artWidth} height={initialLayout.height} style={{maskType:'luminance'}}>
          <rect ref={maskGround} width={artWidth} height={initialLayout.height} fill="white"/>
          <circle ref={clearance} cx={initialLayout.originX} cy={initialLayout.originY} r={initialLayout.opening} fill="black"/>
        </mask>
      </defs>
      <g fill={scene.tone} mask={`url(#${opening})`}>
        <path ref={nearField} fillRule="nonzero"/>
        <polygon ref={bridge}/>
        <path ref={farField} d={square.path}/>
      </g>
      <circle ref={origin} data-projection-origin="" cx={initialLayout.originX} cy={initialLayout.originY} r={initialLayout.productRadius} fill="#FF5724"/>
    </svg>
    <LandingMediaWindow data-projection-end="" data-frame-fill={scene.tone} className="landing-projection-end">
      <div ref={plate} className="landing-projection-plate">
        <WorldImage key={scene.src} scene={scene} onError={onError} onReady={ready => controller.current?.imageReady(ready)}/>
      </div>
    </LandingMediaWindow>
  </figure>;
}

export default LandingProjection;
