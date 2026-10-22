import {useId, useLayoutEffect, useRef, type RefObject} from 'react';
import {GlassineStudy,glassinePoster,type GlassineStudyHandle} from './GlassineStudy';
import {FrameOutside,useFrameSource,useFrameInvalidation,useFrameTransitionShrink,type FrameVisual} from './DynamicFrame';
import {frameBounds,framePath,roundedFrameNodes} from './frameGeometry';
import {createPhilosophySequence,philosophySequenceNodes,philosophySequenceContour} from './philosophySequence';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import {createContourQuery} from './philosophyContour';
import {PHILOSOPHY_SCREENSHOTS} from './philosophyScreenshots';
import {philosophyScrollProgress} from './philosophyMotion';
import {PAGE_SCROLL_RESET_EVENT} from './pageScroll';
import {mountContourText,paintContourText,contourTextMoving,unmountContourText,resetContourText,type ContourTextBlock,type ContourTextCache} from './philosophyTextDom';
import navArrow from './assets/gesso/about-arrow-up-right.svg';
import './shape-light.css';
import './site-grid.css';

const EMPTY_FRAME=roundedFrameNodes({left:0,top:0,right:0,bottom:0});

export const PHILOSOPHY_INTRO = {
  label:'gesso (noun)',
  heading:'A ground applied to a surface before painting.',
  bridge:'We prepare the scene around your product. These principles guide how the studio works.',
};
export const PHILOSOPHY_ROWS = [
  {id:'result', label:'01 / the result', title:'A finished image. At any step.', side:'right', paragraphs:['From any step, jump to a polished still or film. Gesso fills the gaps around the decisions you’ve made. Everything it adds stays inspectable and editable.']},
  {id:'product', label:'02 / the product', title:'Same product. Different scene.', side:'left', paragraphs:['Change the room, light, or camera. Your product keeps its dimensions, parts, materials, artwork, and motion.']},
  {id:'interface', label:'03 / the interface', title:'One opening. Different work.', side:'right', paragraphs:['The same boundary makes room for a parts tree, a material, a camera, a timeline. The product stays visible. Controls appear where their effects can be seen.']},
  {id:'person', label:'04 / the person', title:'For the person making the next version.', side:'left', paragraphs:['A supplier or CG artist prepares the asset. The designer directs, revises, and exports.', 'A new label. Another finish. A different room. The scene stays editable for whatever comes next.']},
] as const;

function StaticShape({stage}:{stage:number}) {
  const clipId=`${useId().replace(/:/g,'')}-screenshot`;
  const nodes=philosophySequenceNodes(1280,832,stage),bounds=frameBounds(nodes);
  const screenshot=PHILOSOPHY_SCREENSHOTS.find(image=>image.stage===stage)!;
  const path=framePath(nodes);
  return <svg className="shape-light-mobile-specimen" viewBox={`${bounds.left} ${bounds.top} ${bounds.width} ${bounds.height}`} aria-hidden="true">
    <defs><clipPath id={clipId} clipPathUnits="userSpaceOnUse"><path d={path}/></clipPath></defs>
    <path d={path}/>
    <image href={screenshot.src} x={bounds.left} y={bounds.top} width={bounds.width} height={bounds.height} preserveAspectRatio={`${screenshot.alignment} slice`} clipPath={`url(#${clipId})`}/>
  </svg>;
}

type FlowRect={left:number;top:number;width:number;height:number};
type FlowBlock={
  element:HTMLElement;section:HTMLElement;text:ContourTextBlock|null;side:'left'|'right';
  base:FlowRect;sectionLeft:number;sectionRight:number;sectionTop:number;sectionBottom:number;
};
type FlowLayout={
  intro:HTMLElement;blocks:FlowBlock[];width:number;height:number;textCache:ContourTextCache;textReady:boolean;
  query:ReturnType<typeof createContourQuery>;
};
const FLOW_PROPERTIES=['left','width','right','margin-left','position','top','bottom','height'];
function restoreFlowLayout(layout:FlowLayout){
  for(const block of layout.blocks){
    unmountContourText(block.text);block.text=null;delete block.element.dataset.flowBlocked;
    for(const property of FLOW_PROPERTIES)block.element.style.removeProperty(property);
  }
}
function createFlowLayout(root:HTMLElement,intro:HTMLElement):FlowLayout{
  const elements=[...root.querySelectorAll<HTMLElement>('.shape-light-dictionary, .shape-light-chapter-copy')];
  return {intro,width:root.clientWidth,height:root.clientHeight,textCache:new Map(),textReady:document.fonts.status==='loaded',query:createContourQuery([]),
    blocks:elements.map(element=>({element,section:element.parentElement!,text:null,
      side:element.dataset.flowSide==='left'?'left':'right',
      base:{left:0,top:0,width:0,height:0},sectionLeft:0,sectionRight:0,sectionTop:0,sectionBottom:0}))};
}
/** Read the authored grid once at resize/font changes. During motion every
 * heading and paragraph keeps this anchor; individual lines follow the edge. */
function measureFlowLayout(layout:FlowLayout,scroll:number){
  restoreFlowLayout(layout);
  for(const block of layout.blocks){
    const rect=block.element.getBoundingClientRect(),section=block.section.getBoundingClientRect();
    block.base={left:rect.left,top:rect.top+scroll,width:rect.width,height:rect.height};
    block.sectionLeft=section.left;block.sectionRight=section.right;
    block.sectionTop=section.top+scroll;block.sectionBottom=section.bottom+scroll;
    if(layout.width<=900||!layout.textReady)continue;
    block.text=mountContourText(block.element,rect,layout.textCache);
    Object.assign(block.element.style,{position:'absolute',left:`${rect.left-section.left}px`,
      top:`${rect.top-section.top}px`,bottom:'auto',right:'auto',marginLeft:'0',width:`${rect.width}px`,height:`${rect.height}px`});
    // Offscreen chapters must remain complete for Find and assistive reading.
    // Only contour updates are visibility-gated; initial text never is.
    const height=paintContourText(block.text,{left:rect.left,top:rect.top,right:section.right,laneLeft:section.left,side:block.side,query:()=>null});
    block.element.style.height=`${height}px`;
  }
}
function flowAroundShape(layout:FlowLayout,scroll:number,animate:boolean,now:number){
  if(layout.width<=900||!layout.textReady)return;
  for(const block of layout.blocks){
    if(!block.text)continue;
    const visible=block.sectionBottom-scroll>=0&&block.sectionTop-scroll<=layout.height;
    if(!visible&&!contourTextMoving(block.text))continue;
    const height=paintContourText(block.text,{left:block.base.left,top:block.base.top-scroll,
      right:block.sectionRight,laneLeft:block.sectionLeft,side:block.side,query:layout.query,animate:animate&&visible,now});
    const blocked=String(block.text.blockedLines);
    if(block.element.dataset.flowBlocked!==blocked)block.element.dataset.flowBlocked=blocked;
    const value=`${height}px`;
    if(block.element.style.height!==value)block.element.style.height=value;
  }
}

/** Scroll is the reversible playhead for the shared frame. Text stays native;
 * scrolling updates geometry without rebuilding the page.
 */
function usePhilosophyFrames(active:boolean,study:RefObject<GlassineStudyHandle|null>,shrink:number) {
  const page = useRef<HTMLDivElement>(null);
  const intro = useRef<HTMLElement>(null);
  const visual = useRef<FrameVisual|null>(null);
  const shrinkRef=useRef(shrink);shrinkRef.current=shrink;
  const refreshGeometry=useRef<(()=>void)|null>(null);
  const invalidate=useFrameInvalidation();
  useFrameSource('philosophy',()=>visual.current);
  useLayoutEffect(() => {
    const root = page.current, first = intro.current;
    if (!root || !first) return;
    const preference = matchMedia(STATIC_MOTION_QUERY);
    const layout = createFlowLayout(root, first);
    const palette = getComputedStyle(root);
    const ground = palette.getPropertyValue('--shape-ground').trim() || '#4e2d97';
    const specimen = palette.getPropertyValue('--shape-specimen').trim() || '#d9d9d9';
    const halo = palette.getPropertyValue('--shape-halo').trim() || '#a546dc';
    const sections=[first,...root.querySelectorAll<HTMLElement>('.shape-light-chapter')];
    let stops:number[]=[];
    let frame = 0, alive = true,initialHashRestored=false;
    let needsLayout=true,lastShown=NaN,lastScroll=NaN,lastShrink=NaN;
    let sample=createPhilosophySequence(layout.width,layout.height);
    const paint = () => {
      frame = 0;
      const now=performance.now();
      const scroll=root.scrollTop;
      if(needsLayout){
        measureFlowLayout(layout,scroll);
        // Use the browser's fractional snap coordinates, including header inset.
        const viewportTop=root.getBoundingClientRect().top;
        const inset=parseFloat(getComputedStyle(root).scrollPaddingTop)||0;
        stops=layout.blocks.map(block=>Math.max(0,block.sectionTop-viewportTop-inset));
        sample=createPhilosophySequence(layout.width,layout.height);
        root.dataset.textLayout=layout.width>900&&layout.textReady?'pretext-lines':'native';
      }
      const compact=layout.width<=900;
      // The browser owns scrolling. Shape and text follow its actual offset;
      // neither the old study controller nor saved tuning can change it.
      const progress=philosophyScrollProgress(scroll,stops);
      const shown = preference.matches||compact ? Math.round(progress) : progress;
      const geometryChanged=needsLayout||shown!==lastShown||shrinkRef.current!==lastShrink;
      const textMoving=layout.blocks.some(block=>block.text&&contourTextMoving(block.text));
      if(!geometryChanged&&(compact||(scroll===lastScroll&&!textMoving)))return;
      const frameName = ['ground','principles',...PHILOSOPHY_ROWS.map(row=>row.id)][Math.round(shown)];
      if (root.dataset.frame !== frameName) root.dataset.frame = frameName;
      const nodes=compact?EMPTY_FRAME:geometryChanged?sample(shown,shrinkRef.current):visual.current!.nodes;
      if(geometryChanged&&!compact)layout.query=createContourQuery(philosophySequenceContour(nodes));
      // Expand blur and spread together so the halo reaches farther without
      // concentrating the existing purple into a brighter, tighter rim.
      const lightScale=Math.min(1.25,layout.width/1280,layout.height/832);
      visual.current={nodes,ground,fill:compact?'transparent':specimen,
        halo:{color:halo,blur:136*lightScale,spread:64*lightScale,opacity:compact?0:1}};
      // The shared renderer measures section clips before text writes can
      // invalidate layout. Shape, text and material still commit in this frame.
      if(geometryChanged||scroll!==lastScroll)invalidate('philosophy');
      if(!compact){
        flowAroundShape(layout,scroll,!preference.matches&&!needsLayout,now);
        const bounds=frameBounds(nodes),query=layout.query;
        study.current?.update({progress:shown,width:layout.width,height:layout.height,
          bounds:{x:bounds.left/layout.width,y:bounds.top/layout.height,width:bounds.width/layout.width,height:bounds.height/layout.height},
          contains:(x,y)=>{const interval=query(y,y);return Boolean(interval&&x>=interval.left&&x<=interval.right);}});
      }else study.current?.update({progress:1,width:layout.width,height:layout.height,bounds:{x:0,y:0,width:1,height:1},contains:()=>false});
      needsLayout=false;lastShown=shown;lastScroll=scroll;lastShrink=shrinkRef.current;
      if(active&&layout.blocks.some(block=>block.text&&contourTextMoving(block.text)))schedule();
    };
    const schedule = () => {if(alive&&!document.hidden&&!frame)frame=requestAnimationFrame(paint);};
    const resetScroll = () => {
      // Hidden pages do not listen for normal scrolling. Publish the cover
      // synchronously so route travel never targets the previous chapter.
      cancelAnimationFrame(frame);frame=0;needsLayout=true;paint();
    };
    root.addEventListener(PAGE_SCROLL_RESET_EVENT,resetScroll);
    refreshGeometry.current=schedule;
    const visibility=()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else if(active)schedule();};
    const resize = () => {
      needsLayout=true;
      layout.width = root.clientWidth; layout.height = root.clientHeight;
      schedule();
    };
    const followHash = () => {
      if(!active||!/^\/aperture\/?$/.test(location.pathname))return;
      if (!['#shape-light-content', '#shape-light-principles',...PHILOSOPHY_ROWS.map(row=>`#principle-${row.id}`)].includes(location.hash)) return;
      const target = root.querySelector<HTMLElement>(location.hash);
      if (target) {
        target.focus({preventScroll:true});
        target.scrollIntoView({block:'start', behavior:'instant'});
      }
      schedule();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(root); for(const section of sections)observer.observe(section);
    if(active)root.addEventListener('scroll',schedule,{passive:true});
    document.addEventListener('visibilitychange',visibility);
    preference.addEventListener('change', schedule);
    window.addEventListener('hashchange', followHash);
    const fontsLoaded=()=>{
      if(!alive)return;
      resetContourText(layout.textCache);layout.textReady=true;resize();
      // A late font from another page must not pull us back to an old anchor.
      if(!initialHashRestored){initialHashRestored=true;followHash();}
    };
    document.fonts.addEventListener('loadingdone',fontsLoaded);
    void document.fonts.ready.then(fontsLoaded);
    paint();
    return () => {
      alive = false; refreshGeometry.current=null; cancelAnimationFrame(frame); observer.disconnect();
      root.removeEventListener('scroll',schedule);
      root.removeEventListener(PAGE_SCROLL_RESET_EVENT,resetScroll);
      document.removeEventListener('visibilitychange',visibility);
      preference.removeEventListener('change', schedule);
      window.removeEventListener('hashchange', followHash);
      document.fonts.removeEventListener('loadingdone',fontsLoaded);
      restoreFlowLayout(layout);layout.textCache.clear();
    };
  }, [active,invalidate,study]);
  // A stationary intermediate frame can change scale without rebuilding text
  // or replaying initial hash restoration.
  useLayoutEffect(()=>refreshGeometry.current?.(),[shrink]);
  return {page, intro};
}

export default function ShapeLightPage({active=true}:{active?:boolean}) {
  const study=useRef<GlassineStudyHandle|null>(null);
  const [shrink]=useFrameTransitionShrink();
  const {page, intro} = usePhilosophyFrames(active,study,shrink);
  return <div ref={page} className="gesso-shape-light" data-frame="ground" data-frame-scroll tabIndex={-1} inert={!active} aria-hidden={!active}>
    <GlassineStudy ref={study} active={active} page={page}/>
    <a data-frame-outside className="shape-light-skip" href="#shape-light-content">Skip to philosophy</a>
    <a data-frame-outside className="shape-light-skip" href="#shape-light-principles">Skip to principles</a>
    <header data-frame-outside className="shape-light-header gesso-site-header">
      <a className="shape-light-wordmark gesso-site-wordmark" href="/landing" aria-label="gesso home">gesso</a>
      <nav className="gesso-site-nav" aria-label="Main navigation">
        <a className="site-about-link" href="/about">about</a>
        <a className="site-study-link" href="#shape-light-content" aria-current="page">form + light</a>
        <a className="site-studio-link" data-studio-resume href="/?step=product&layer=model">enter studio <img src={navArrow} alt="" width="14" height="20"/></a>
      </nav>
    </header>
    <main id="shape-light-content" tabIndex={-1}>
      <FrameOutside as="section" ref={intro} className="shape-light-intro" aria-labelledby="shape-light-title">
        <div className="shape-light-dictionary" data-flow-side="left">
          <p className="shape-light-index">{PHILOSOPHY_INTRO.label}</p>
          <h1 id="shape-light-title" tabIndex={-1}>{PHILOSOPHY_INTRO.heading}</h1>
          <p className="shape-light-bridge">{PHILOSOPHY_INTRO.bridge}</p>
        </div>
        <div className="shape-light-mobile-shape" aria-hidden="true"><img src={glassinePoster} alt=""/></div>
      </FrameOutside>
      <FrameOutside as="section" id="shape-light-principles" className="shape-light-chapter shape-light-opener" aria-labelledby="shape-light-principles-title" tabIndex={-1}>
        <div className="shape-light-chapter-copy" data-flow-side="left">
          <p className="shape-light-index">form + light / principles</p>
          <h2 id="shape-light-principles-title">How we<br/>make things.</h2>
          <nav className="shape-light-contents" aria-label="Principles">
            {PHILOSOPHY_ROWS.map(row=><a key={row.id} href={`#principle-${row.id}`}><span>{row.label.slice(0,2)}</span>{row.label.slice(5)}</a>)}
          </nav>
        </div>
        <StaticShape stage={1}/>
      </FrameOutside>
      {PHILOSOPHY_ROWS.map((row,index)=><FrameOutside as="section" id={`principle-${row.id}`} className={`shape-light-chapter shape-light-principle shape-light-${row.id}`} data-copy-side={row.side} aria-labelledby={`principle-${row.id}-title`} key={row.id} tabIndex={-1}>
        <div className="shape-light-chapter-copy" data-flow-side={row.side}>
          <p className="shape-light-index">{row.label}</p>
          <h2 id={`principle-${row.id}-title`}>{row.title}</h2>
          <div className="shape-light-copy">{row.paragraphs.map(paragraph=><p key={paragraph}>{paragraph}</p>)}</div>
        </div>
        <StaticShape stage={index+2}/>
      </FrameOutside>)}
    </main>
  </div>;
}
