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
import PublicSiteHeader from './PublicSiteHeader';
import './shape-light.css';
import './site-grid.css';

const EMPTY_FRAME=roundedFrameNodes({left:0,top:0,right:0,bottom:0});

export const PHILOSOPHY_INTRO = {
  label:'gesso (noun)',
  heading:'A ground applied to a surface before painting.',
  bridge:'In Gesso, the ground is a 3D setting. Your product sits in it as a separate model.',
};
export const PHILOSOPHY_ROWS = [
  {id:'result', label:'Rendering', title:'Choose the shot before you render.', side:'right', paragraphs:['Frame a still or arrange shots on the timeline. Set the light, lens and focus before rendering; the scene stays editable afterward.']},
  {id:'product', label:'The model', title:'Change the setting around your model.', side:'left', paragraphs:['The product and setting remain separate. You can replace the setting while retaining the model’s materials and artwork.']},
  {id:'interface', label:'The viewport', title:'Edit the part you’re looking at.', side:'right', paragraphs:['Select a part to change its finish, or switch to Film to set the camera. The viewport stays visible while you work.']},
  {id:'person', label:'Revisions', title:'Reopen the scene for the next revision.', side:'left', paragraphs:['Start with a model prepared by you, your supplier or a CG artist. When a new label arrives, replace the artwork and render another image from the saved scene.']},
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
    const ground = palette.getPropertyValue('--shape-ground').trim() || '#fafaf7';
    const specimen = palette.getPropertyValue('--shape-specimen').trim() || '#d9d9d9';

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
      visual.current={nodes,ground,fill:compact?'transparent':specimen,
        halo:{color:ground,blur:0,spread:0,opacity:0}};
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
    <div data-frame-outside className="shape-light-header"><PublicSiteHeader current="philosophy"/></div>
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
          <h2 id="shape-light-principles-title">Inside the studio</h2>
          <nav className="shape-light-contents" aria-label="Principles">
            {PHILOSOPHY_ROWS.map(row=><a key={row.id} href={`#principle-${row.id}`}>{row.label}</a>)}
          </nav>
        </div>
        <StaticShape stage={1}/>
      </FrameOutside>
      {PHILOSOPHY_ROWS.map((row,index)=><FrameOutside as="section" id={`principle-${row.id}`} className={`shape-light-chapter shape-light-principle shape-light-${row.id}`} data-copy-side={row.side} aria-labelledby={`principle-${row.id}-title`} key={row.id} tabIndex={-1}>
        <div className="shape-light-chapter-copy" data-flow-side={row.side}>
          <h2 id={`principle-${row.id}-title`}>{row.title}</h2>
          <div className="shape-light-copy">{row.paragraphs.map(paragraph=><p key={paragraph}>{paragraph}</p>)}</div>
        </div>
        <StaticShape stage={index+2}/>
      </FrameOutside>)}
    </main>
    <footer className="shape-light-endnote"><a href="/about">About Gesso</a><a data-studio-resume href="/?step=product&layer=model">Enter studio</a></footer>
  </div>;
}
