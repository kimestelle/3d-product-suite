import {useEffect, useId, useState} from 'react';
import {CURVE_PRESETS} from './curvePresets';
import {frameBounds, framePath, loadingFrameNodes, transformFrameNodes, type FrameNodes} from './frameGeometry';
import {frameHaloRegion} from './frameHalo';
import './curve-demo.css';
import './logo-study.css';

const versions = [
  {id:'fine', family:'x', name:'Fine', weight:1.5, note:'A lighter edge. More delicate at favicon size.'},
  {id:'balanced', family:'x', name:'Balanced', weight:2, note:'A clear edge and open center. Enough weight for small sizes.'},
  {id:'bold', family:'x', name:'Bold', weight:2.5, note:'More presence at small sizes. Heavier beside the wordmark.'},
  {id:'halo-oval', family:'oval', name:'Halo oval', weight:0, note:'An oval cutout with a close halo, extended slightly sideways.'},
] as const;
type Version = typeof versions[number];
const source = CURVE_PRESETS.find(shape => shape.id === 'studio-cross')!.nodes;

function fittedNodes(nodes:FrameNodes) {
  const bounds=frameBounds(nodes),cx=(bounds.left+bounds.right)/2,cy=(bounds.top+bounds.bottom)/2;
  return transformFrameNodes(nodes,{
    scaleX:104/Math.max(bounds.width,bounds.height),origin:{x:cx,y:cy},translateX:64-cx,translateY:64-cy,
  });
}

// Same 18:7.5 proportions and 45° projection as the existing favicon/mobile mark.
const oval=transformFrameNodes(fittedNodes(transformFrameNodes(loadingFrameNodes({x:0,y:0},18),{scaleY:7.5/18,rotation:45})),{scaleX:.68,origin:{x:64,y:64}});
const paths={x:framePath(fittedNodes(source)),oval:framePath(oval)};
// Slight horizontal spread, with the same oval contour and an empty center.
const halo={blur:3,alphaGain:3};
const haloNodes=transformFrameNodes(oval,{scaleX:1.12,scaleY:1,origin:{x:64,y:64}});
const haloPath=framePath(haloNodes);
const haloRegion=frameHaloRegion(frameBounds(haloNodes),halo.blur,0);
const versionPath=(version:Version)=>paths[version.family];

function readState() {
  const params = new URLSearchParams(location.search);
  const selected = versions.find(version => version.id === params.get('logo'))?.id ?? 'halo-oval';
  const choice = versions.find(version => version.id === params.get('choice'))?.id ?? null;
  const discardedBlob=['soft-x','pebble'].includes(params.get('logo')??'');
  return {selected, choice, ink:discardedBlob || params.get('ground') !== 'chalk'};
}

function Mark({version, size, className = ''}:{version:Version;size:number;className?:string}) {
  const id=useId().replace(/:/g,''),filterId=`oval-light-${id}`,maskId=`oval-center-${id}`;
  const isOval=version.family==='oval';
  return <svg className={`logo-study-mark ${className}`} width={size} height={size} viewBox="0 0 128 128" aria-hidden="true">
    {isOval?<><defs>
      <filter id={filterId} {...haloRegion} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation={halo.blur}/><feComponentTransfer><feFuncA type="linear" slope={halo.alphaGain}/></feComponentTransfer></filter>
      <mask id={maskId} {...haloRegion} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style={{maskType:'luminance'}}><rect {...haloRegion} fill="white"/><path d={paths.oval} fill="black"/></mask>
    </defs><g mask={`url(#${maskId})`}><path d={haloPath} fill="currentColor" filter={`url(#${filterId})`}/></g></>:<path d={versionPath(version)} fill="none" stroke="currentColor" strokeWidth={version.weight*4} strokeLinecap="round" strokeLinejoin="round"/>}
  </svg>;
}

/** The accepted oval and alternative outlines; selecting a study never changes site identity. */
export default function LogoStudy() {
  const [initial] = useState(readState);
  const [selected,setSelected] = useState<Version['id']>(initial.selected);
  const [choice,setChoice] = useState<Version['id']|null>(initial.choice);
  const [ink,setInk] = useState(initial.ink);
  const [notice,setNotice] = useState('');
  const active = versions.find(version => version.id === selected)!;
  const isOval=active.family==='oval';
  const visibleVersions=versions.filter(version=>version.family===active.family);
  const params = new URLSearchParams(location.search);
  for (const key of ['study','logo','choice','ground']) params.delete(key);
  const backUrl = `/curves${params.size ? `?${params}` : ''}`;

  useEffect(() => {document.title='Logo study — gesso';},[]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('study','logo');
    url.searchParams.set('logo',selected);
    url.searchParams.set('ground',ink?'ink':'chalk');
    if (choice) url.searchParams.set('choice',choice); else url.searchParams.delete('choice');
    history.replaceState(history.state,'',url.pathname+url.search);
  },[selected,choice,ink]);
  useEffect(() => {
    const restore = () => {const state=readState();setSelected(state.selected);setChoice(state.choice);setInk(state.ink);};
    window.addEventListener('popstate',restore);
    return () => window.removeEventListener('popstate',restore);
  },[]);
  const exportSvg = () => {
    const color=ink?'#f9faf7':'#131313';
    const region=haloRegion;
    const regionAttributes=`x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}"`;
    const ovalArt=`<defs><filter id="halo" ${regionAttributes} filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${halo.blur}"/><feComponentTransfer><feFuncA type="linear" slope="${halo.alphaGain}"/></feComponentTransfer></filter><mask id="center" ${regionAttributes} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" style="mask-type:luminance"><rect ${regionAttributes} fill="white"/><path d="${paths.oval}" fill="black"/></mask></defs><g mask="url(#center)"><path d="${haloPath}" fill="${color}" filter="url(#halo)"/></g>`;
    // Include the halo's full measured bounds in the exported SVG canvas.
    const viewBox=isOval?`${region.x} ${region.y} ${region.width} ${region.height}`:'0 0 128 128';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${isOval?ovalArt:`<path d="${versionPath(active)}" fill="none" stroke="${color}" stroke-width="${active.weight*4}" stroke-linecap="round" stroke-linejoin="round"/>`}</svg>`;
    const url = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    const link = document.createElement('a');
    link.href=url;link.download=`gesso-${active.family}-${active.id}.svg`;
    document.body.append(link);link.click();link.remove();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice(`${active.name} SVG exported`);
  };

  return <div className="curve-demo logo-study">
    <header className="curve-header">
      <a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a>
      <h1>Logo study <span>design system</span></h1>
      <nav aria-label="Study navigation"><a href={backUrl}>← Curves</a><a href="/aperture">Form + light</a><button onClick={exportSvg}>Export SVG ↗</button></nav>
    </header>
    <div className="curve-workspace">
      <aside className="curve-library logo-study-controls" aria-label="Logo controls">
        <div className="curve-library-heading"><h2>{isOval?'Form + light.':'The X, outlined.'}</h2><span>{isOval?'01':'01–03'}</span></div>
        <fieldset className="logo-study-family"><legend>Direction</legend><div>
          <button type="button" aria-pressed={!isOval} onClick={()=>{setSelected('balanced');setNotice('');}}>X</button>
          <button type="button" aria-pressed={isOval} onClick={()=>{setSelected('halo-oval');setNotice('');}}>Oval</button>
        </div></fieldset>
        <p className="logo-study-intro">{isOval?<>One circle, seen at an angle.<br/>A little light at the edge.</>:<>One contour. Three line weights.<br/>Choose a mark to inspect it.</>}</p>
        <section className="logo-study-selection" aria-labelledby="logo-selection-title">
          <span className="logo-study-label">Selected</span>
          <h3 id="logo-selection-title">{active.name}</h3>
          <p>{active.note}</p>
          <dl><dt>{isOval?'Angle':'Stroke at 32px'}</dt><dd>{isOval?'45°':`${active.weight} px`}</dd><dt>Contour</dt><dd>64 anchors</dd></dl>
        </section>
        <fieldset className="logo-study-ground"><legend>Preview ground</legend><div>
          <button type="button" aria-pressed={!ink} onClick={()=>setInk(false)}>Chalk</button>
          <button type="button" aria-pressed={ink} onClick={()=>setInk(true)}>Ink</button>
        </div></fieldset>
        <div className="logo-study-decision">
          <button className="logo-study-shortlist" disabled={isOval} onClick={()=>{setChoice(active.id);setNotice(`${active.name} shortlisted`);}}>{isOval?'In use on website':choice===active.id?'Shortlisted ✓':`Shortlist ${active.name}`}</button>
          <p role="status" aria-live="polite">{notice || (isOval ? 'Browser tab + mobile navigation' : choice ? `${versions.find(version=>version.id===choice)!.name} shortlisted` : 'Draft · choose before applying')}</p>
        </div>
      </aside>
      <main className="curve-main logo-study-main" data-ground={ink?'ink':'chalk'}>
        <section className="logo-study-board" aria-label={isOval?'Halo oval logo':'Compare outline X logos'}>
          <div className="logo-study-board-heading"><span>{isOval?'Perspective oval':'Same shape / same size'}</span><span>{isOval?'Opaque inner edge / soft outer edge':'Only the line weight changes'}</span></div>
          {isOval?<div className="logo-study-oval-stage"><Mark version={active} size={232} className="logo-study-oval-display"/><div className="logo-study-sizes">{[16,24,32].map(size=><span key={size}><span className="logo-study-size-mark"><Mark version={active} size={size}/></span><span>{size}px</span></span>)}</div><span className="logo-study-label">No outline</span></div>:<div className="logo-study-versions" data-family={active.family}>
            {visibleVersions.map((version,index)=><button key={version.id} className="logo-study-version" aria-pressed={selected===version.id} aria-label={`Select ${version.name}`} onClick={()=>{setSelected(version.id);setNotice('');}}>
              <span className="logo-study-version-label"><span>0{index+1} / {version.name}</span><span>{version.id==='balanced'?'recommended':`${version.weight} px`}</span></span>
              <Mark version={version} size={184} className="logo-study-large"/>
              <span className="logo-study-sizes">{[16,24,32].map(size=><span key={size}><span className="logo-study-size-mark"><Mark version={version} size={size}/></span><span>{size}px</span></span>)}</span>
              <span className="logo-study-selection-state">{selected===version.id?'Selected':'Select'}</span>
            </button>)}
          </div>}
          <div className="logo-study-context" aria-label={`${active.name} in use`}>
            <div className="logo-study-lockup"><span className="logo-study-label">Beside the wordmark</span><div><Mark version={active} size={44}/><span>gesso</span></div></div>
            <div className="logo-study-small-context"><span className="logo-study-label">Browser tab / 16px</span><div className="logo-study-tab"><Mark version={active} size={16}/><span>gesso</span><span aria-hidden="true">×</span></div></div>
            <div className="logo-study-opposite"><span className="logo-study-label">Reversed / 32px</span><div><Mark version={active} size={32}/></div></div>
          </div>
        </section>
        <footer className="logo-study-footer"><span>{isOval?'From the favicon and studio loader':'From the landing window’s X'}</span><span>{isOval?'Oval cutout + close halo':'Transparent center'} · editable SVG</span></footer>
      </main>
    </div>
  </div>;
}
