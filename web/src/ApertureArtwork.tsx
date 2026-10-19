import {renderToStaticMarkup} from 'react-dom/server';

/** Distances are SVG units: the aperture's working plane is 1000 × 600. */
export type ApertureAppearance = {
  width: number;
  softness: number;
  strength: number;
  separation: number;
  angle: number;
  tint: string;
  background: string;
  interior: 'empty' | 'solid' | 'scene';
};

export type ApertureArtworkProps = {
  path: string;
  settings: ApertureAppearance;
  id: string;
  sceneHref?: string;
};

const clamp = (value: number, min: number, max: number) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
const color = (value: string, fallback: string) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
const bounds = {x: -140, y: -140, width: 1280, height: 880};

/**
 * One editable contour supplies the optical field, the exact inner knockout,
 * and the scene clip. Channel offsets affect only the halo, never the product.
 */
export function ApertureArtwork({path, settings, id, sceneHref}: ApertureArtworkProps) {
  const prefix = `aperture-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const contour = `${prefix}-contour`;
  const clip = `${prefix}-clip`;
  const outside = `${prefix}-outside`;
  const halo = `${prefix}-halo`;
  const width = clamp(settings.width, 0, 80);
  const softness = clamp(settings.softness, 0, 50);
  const strength = clamp(settings.strength, 0, 1);
  const separation = clamp(settings.separation, 0, 16);
  const angle = (Number.isFinite(settings.angle) ? settings.angle : 0) * Math.PI / 180;
  const dx = Math.cos(angle) * separation;
  const dy = Math.sin(angle) * separation;
  const tint = color(settings.tint, '#d4b9d8');
  const background = color(settings.background, '#131313');
  const channels=[1,3,5].map(index=>parseInt(background.slice(index,index+2),16)/255);
  const edge=channels[0]*.2126+channels[1]*.7152+channels[2]*.0722>.5?'#08080a':'#f9faf7';

  return <g data-aperture-artwork="true">
    <defs>
      <path id={contour} d={path}/>
      <clipPath id={clip} clipPathUnits="userSpaceOnUse"><use href={`#${contour}`}/></clipPath>
      <mask id={outside} maskUnits="userSpaceOnUse" {...bounds} style={{maskType: 'luminance'}}>
        <rect {...bounds} fill="white"/>
        <use href={`#${contour}`} fill="black"/>
      </mask>
      <filter id={halo} filterUnits="userSpaceOnUse" {...bounds} colorInterpolationFilters="sRGB">
        {/* Two scales share the same silhouette: a near edge and a quiet tail. */}
        <feGaussianBlur in="SourceGraphic" stdDeviation={softness * .42} result="near"/>
        <feGaussianBlur in="SourceGraphic" stdDeviation={softness} result="wide"/>
        <feComponentTransfer in="near" result="near-weight"><feFuncA type="linear" slope="0.78"/></feComponentTransfer>
        <feComponentTransfer in="wide" result="wide-weight"><feFuncA type="linear" slope="0.22"/></feComponentTransfer>
        <feMerge result="field"><feMergeNode in="wide-weight"/><feMergeNode in="near-weight"/></feMerge>
        {/* Resolve each displaced sample against the same ground before recombining.
            This preserves the tint at zero separation, including on white, and
            avoids an opaque black fringe from summing transparent RGB layers. */}
        <feFlood floodColor={background} result="ground"/>
        <feOffset in="field" dx={dx} dy={dy} result="red-offset"/>
        <feOffset in="field" dx={-dx} dy={-dy} result="blue-offset"/>
        <feComposite in="red-offset" in2="ground" operator="over" result="red-ground"/>
        <feComposite in="field" in2="ground" operator="over" result="green-ground"/>
        <feComposite in="blue-offset" in2="ground" operator="over" result="blue-ground"/>
        <feColorMatrix in="red-ground" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="red"/>
        <feColorMatrix in="green-ground" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="green"/>
        <feColorMatrix in="blue-ground" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blue"/>
        <feComposite in="red" in2="green" operator="arithmetic" k2="1" k3="1" result="red-green"/>
        <feComposite in="red-green" in2="blue" operator="arithmetic" k2="1" k3="1"/>
      </filter>
    </defs>
    {width > 0 && strength > 0 && <g mask={`url(#${outside})`} opacity={strength}>
      <use href={`#${contour}`} fill="none" stroke={tint} strokeWidth={width * 2} strokeLinejoin="round" filter={`url(#${halo})`}/>
    </g>}
    <use href={`#${contour}`} fill={settings.interior === 'solid' ? tint : background} stroke={edge} strokeOpacity=".1" strokeWidth="1"/>
    {settings.interior === 'scene' && sceneHref && <image href={sceneHref} x="0" y="0" width="1000" height="600" preserveAspectRatio="xMidYMid slice" clipPath={`url(#${clip})`}/>}
  </g>;
}

/** Same renderer as the live stage. Pass a data URL to embed the scene image. */
export function apertureSvgMarkup(path: string, settings: ApertureAppearance, sceneHref?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" width="1280" height="880" viewBox="-140 -140 1280 880">
      <title>gesso aperture</title>
      <rect {...bounds} fill={color(settings.background, '#131313')}/>
      <ApertureArtwork path={path} settings={settings} id="export" sceneHref={sceneHref}/>
    </svg>,
  )}`;
}
