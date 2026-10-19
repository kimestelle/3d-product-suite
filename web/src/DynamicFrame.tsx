import {createContext, forwardRef, useContext, useId, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode, type Ref} from 'react';
import {framePath, loadingFrameNodes, roundedFrameNodes, type FrameNodes} from './frameGeometry';
import {entranceEase} from './studioEntrance';
import {createFrameMorph} from './frameMorph';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import {createStudioExpansion,studioLoadingNodes} from './studioLoading';
import {frameGuidePaths} from './frameGuides';
import './dynamic-frame.css';

export type FrameRoute = 'landing' | 'about' | 'philosophy' | 'studio';
export type FrameVisual = {nodes:FrameNodes; ground:string; fill:string; halo:{color:string; blur:number; spread:number; opacity:number}};
type FrameElements = {root:HTMLElement; path:SVGPathElement; outside?:SVGPathElement; guides?:SVGPathElement; guideCrosses?:SVGPathElement; halo:SVGUseElement; fill:SVGUseElement; blur:SVGFEGaussianBlurElement};
type Travel = {from:FrameVisual; weights:Record<FrameRoute,number>; destination:FrameRoute; start:number; duration:number; loading:boolean; opening:boolean; to:FrameVisual; morph:ReturnType<typeof createFrameMorph>};
const routes:FrameRoute[] = ['landing','about','philosophy','studio'];
const weights = (page?:FrameRoute):Record<FrameRoute,number> => Object.fromEntries(routes.map(route=>[route,route===page?1:0])) as Record<FrameRoute,number>;
const lerp = (a:number,b:number,t:number) => a+(b-a)*t;
const sameContour=(a:FrameNodes,b:FrameNodes)=>a===b||(a.length===b.length&&a.every((node,i)=>
  (['point','in','out'] as const).every(key=>node[key].x===b[i][key].x&&node[key].y===b[i][key].y)));
function rgba(color:string):number[] {
  if(color==='transparent')return [0,0,0,0];
  const hex=color.match(/^#([\da-f]{3,8})$/i)?.[1];
  if(hex) {const full=hex.length<5?hex.split('').map(x=>x+x).join(''):hex;return [0,2,4].map(i=>parseInt(full.slice(i,i+2),16)).concat(full.length===8?parseInt(full.slice(6),16)/255:1);}
  const values=color.match(/[\d.]+/g)?.map(Number)??[0,0,0];
  return color.startsWith('color(srgb')?values.slice(0,3).map(x=>x*255).concat(values[3]??1):values.slice(0,3).concat(values[3]??1);
}
/** Keep the source pigment when it is legible; chrome-colored (or transparent)
 * halos need an actual foreground color before they become a loading glyph. */
export function frameContrastColor(ground:string,preferred='#f9faf7',minimum=4.5):string {
  const luminance=(color:string)=>rgba(color).slice(0,3).map(value=>{
    const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;
  }).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const background=luminance(ground);
  const contrast=(color:string)=>{const foreground=luminance(color);return (Math.max(background,foreground)+.05)/(Math.min(background,foreground)+.05);};
  if(rgba(preferred)[3]>=.999&&contrast(preferred)>=minimum)return preferred;
  return contrast('#f9faf7')>=contrast('#131313')?'#f9faf7':'#131313';
}
function colorMix(a:string,b:string,t:number) {if(a===b)return a;if(t===0)return a;if(t===1)return b;const x=rgba(a),y=rgba(b);return `rgba(${x.slice(0,3).map((v,i)=>lerp(v,y[i],t).toFixed(3)).join(',')},${lerp(x[3],y[3],t)})`;}
function mix(a:FrameVisual,b:FrameVisual,t:number,nodes:FrameNodes):FrameVisual {return {nodes,ground:colorMix(a.ground,b.ground,t),fill:colorMix(a.fill,b.fill,t),halo:{color:colorMix(a.halo.color,b.halo.color,t),blur:lerp(a.halo.blur,b.halo.blur,t),spread:lerp(a.halo.spread,b.halo.spread,t),opacity:lerp(a.halo.opacity,b.halo.opacity,t)}};}

/** One demand-driven clock owns the displayed contour. React owns page identity,
 * readiness and accessibility; it never renders each intermediate frame. */
export class FrameDriver {
  readonly sources=new Map<FrameRoute,()=>FrameVisual|null>();
  readonly hosts=new Map<FrameRoute,HTMLElement>();
  readonly windows=new Set<()=>void>();
  private readonly measured=new Map<FrameRoute,FrameVisual>();
  private readonly dirtySources=new Set<FrameRoute>(routes);
  private readonly windowOwners=new Map<()=>void,FrameRoute|undefined>();
  private readonly dirtyWindows=new Set<()=>void>();
  private painted=new WeakMap<object,Map<string,string>>();
  private hostStates=new WeakMap<HTMLElement,{amount:number;visible:boolean;interactive:boolean}>();
  private pathNodes:FrameNodes|null=null;
  private pathData='';
  private guideData='';
  private guideCrossData='';
  private guideViewport='';
  readonly ready=new Set<FrameRoute>(['landing','about','philosophy']);
  elements:FrameElements|null=null;
  current:FrameVisual|null=null;
  target:FrameRoute;
  currentWeights:Record<FrameRoute,number>;
  travel:Travel|null=null;
  pending=false;
  waiting=false;
  reduced=false;
  private frame=0;
  private lastTime=0;
  private alive=false;
  private preference:MediaQueryList|null=null;
  private resizePending=false;
  private loadingElapsed=0;
  private loadingTick:number|null=null;
  private studioFailed=false;
  onSettled:(page:FrameRoute)=>void=()=>{};
  onWaiting:(waiting:boolean)=>void=()=>{};
  constructor(initial:FrameRoute,readonly pathId:string) {this.target=initial;this.currentWeights=weights(initial);}
  attach(elements:FrameElements) {
    this.elements=elements;this.alive=true;this.painted=new WeakMap();this.hostStates=new WeakMap();this.pathNodes=null;
    this.preference=matchMedia(STATIC_MOTION_QUERY);this.reduced=this.preference.matches;
    this.preference.addEventListener('change',this.preferenceChanged);
    window.addEventListener('resize',this.resize);
    document.addEventListener('visibilitychange',this.visibility);
    this.invalidate();
    return ()=>{this.alive=false;cancelAnimationFrame(this.frame);this.frame=0;this.preference?.removeEventListener('change',this.preferenceChanged);window.removeEventListener('resize',this.resize);document.removeEventListener('visibilitychange',this.visibility);this.elements=null;};
  }
  private preferenceChanged=()=>{this.reduced=!!this.preference?.matches;this.loadingTick=null;this.invalidate();};
  private visibility=()=>{cancelAnimationFrame(this.frame);this.frame=0;this.loadingTick=null;if(!document.hidden){if(this.travel)this.travel.start+=performance.now()-this.lastTime;this.invalidate();}};
  private resize=()=>{this.resizePending=true;for(const page of routes)this.dirtySources.add(page);for(const measure of this.windows)this.dirtyWindows.add(measure);this.invalidate();};
  watchWindow(page:FrameRoute|undefined,measure:()=>void) {
    this.windows.add(measure);this.windowOwners.set(measure,page);this.dirtyWindows.add(measure);
    this.invalidate(page);
    return()=>{this.windows.delete(measure);this.windowOwners.delete(measure);this.dirtyWindows.delete(measure);};
  }
  private measureWindows() {
    for(const measure of this.windows) {
      const page=this.windowOwners.get(measure);
      if(page&&page!==this.target&&this.currentWeights[page]===0)continue;
      if(!page||this.dirtyWindows.has(measure)){measure();this.dirtyWindows.delete(measure);}
    }
  }
  invalidate=(page?:FrameRoute)=>{
    if(page) {
      this.dirtySources.add(page);
      for(const [measure,owner]of this.windowOwners)if(owner===page)this.dirtyWindows.add(measure);
      // Hidden pages may update their cached input, but never wake the renderer.
      if(page!==this.target&&this.currentWeights[page]===0)return;
    }
    if(!this.alive||document.hidden)return;
    // Scroll flow and its contour must commit in the same frame. Queue route
    // travel, but publish an active page's local geometry without another rAF.
    if(page===this.target&&!this.travel&&!this.pending&&!this.waiting&&this.elements) {
      const visual=this.read(this.target);
      if(visual){this.measureWindows();this.current=visual;this.paint();return;}
    }
    if(!this.frame)this.frame=requestAnimationFrame(this.tick);
  };
  register(page:FrameRoute,source:()=>FrameVisual|null) {this.sources.set(page,source);this.invalidate(page);return()=>{if(this.sources.get(page)===source)this.sources.delete(page);};}
  registerHost(page:FrameRoute,host:HTMLElement|null) {if(host)this.hosts.set(page,host);else this.hosts.delete(page);this.invalidate();}
  navigate(page:FrameRoute) {
    this.target=page;this.pending=true;this.waiting=false;this.onWaiting(false);
    this.loadingElapsed=0;this.loadingTick=null;
    this.dirtySources.add(page);for(const measure of this.windows)this.dirtyWindows.add(measure);
    this.paint();this.invalidate();
  }
  markReady(page:FrameRoute) {this.ready.add(page);if(page==='studio')this.studioFailed=false;this.invalidate(page);}
  failStudio() {this.studioFailed=true;this.loadingTick=null;this.invalidate('studio');}
  retryStudio() {this.ready.delete('studio');this.studioFailed=false;this.loadingTick=null;this.invalidate('studio');}
  private read(page:FrameRoute):FrameVisual|null {
    if(!this.dirtySources.has(page)&&this.measured.has(page))return this.measured.get(page)!;
    this.dirtySources.delete(page);
    const visual=this.sources.get(page)?.();
    if(visual){this.measured.set(page,visual);return visual;}
    const previous=this.measured.get(page);if(previous)return previous;
    // A failed initial render may remove its source. Keep an honest loading
    // destination available so error/retry/back never depend on that renderer.
    if(page==='studio'&&typeof innerWidth==='number')return {nodes:roundedFrameNodes({left:innerWidth<900?0:340,top:innerWidth<900?0:116,right:innerWidth,bottom:innerHeight},20),ground:'#131313',fill:'#252525',halo:{color:'#131313',blur:0,spread:0,opacity:0}};
    return null;
  }
  private loading(visual:FrameVisual):FrameVisual {
    const fill=frameContrastColor(visual.ground,visual.halo.color,3);
    return {...visual,nodes:loadingFrameNodes({x:innerWidth/2,y:innerHeight/2}),fill,halo:{...visual.halo,color:fill,blur:20,spread:8,opacity:.5}};
  }
  private begin(from:FrameVisual,to:FrameVisual,now:number,duration:number,loading=false,opening=false):Travel {
    // Prepare correspondence once. Intermediate frames only evaluate the pose;
    // interruptions start with the actual displayed contour, never an old endpoint.
    return {from,to,morph:(opening?createStudioExpansion:createFrameMorph)(from.nodes,to.nodes),weights:{...this.currentWeights},
      destination:this.target,start:now,duration,loading,opening};
  }
  private start(now:number) {
    const target=this.read(this.target);
    if(!target)return false;
    const loading=this.target==='studio'&&!this.ready.has('studio');
    this.pending=false;
    // A direct studio visit has no existing window to contract. Show the
    // centered loading pose on the first frame, before mounting the editor.
    if(loading&&!this.current) {
      this.current=this.loading(target);this.currentWeights=weights();this.travel=null;
      this.waiting=true;this.loadingElapsed=0;this.loadingTick=now;this.onWaiting(true);
      return true;
    }
    const current=this.current??target;
    this.travel=this.begin(current,loading?this.loading(current):target,now,loading?480:680,loading);
    return true;
  }
  private tick=(now:number)=>{
    this.frame=0;this.lastTime=now;
    if(!this.elements)return;
    this.measureWindows();
    if(this.pending&&!this.start(now)){this.invalidate();return;}
    const target=this.read(this.target);
    if(!target)return;
    if(!this.current)this.current=target;
    if(this.travel&&!this.travel.loading) {
      if(this.resizePending||!sameContour(this.travel.to.nodes,target.nodes)) {
        this.travel=this.begin(this.current,target,now,Math.max(160,this.travel.duration-(now-this.travel.start)),false,this.travel.opening);
      } else this.travel.to=target;
    } else if(this.travel?.loading&&this.resizePending) {
      this.travel=this.begin(this.current,this.loading(this.current),now,Math.max(160,this.travel.duration-(now-this.travel.start)),true);
    }
    this.resizePending=false;
    if(this.waiting&&this.ready.has('studio')) {
      this.waiting=false;this.onWaiting(false);
      this.travel=this.begin(this.current,target,now,680,false,true);
    }
    const travel=this.travel;
    if(travel) {
      const raw=this.reduced?1:Math.min(1,Math.max(0,(now-travel.start)/travel.duration));
      const amount=entranceEase(raw);
      const destination=travel.loading?travel.to:target;
      this.current=mix(travel.from,destination,amount,travel.morph(amount));
      const content=entranceEase(Math.min(1,raw/.8));
      for(const page of routes)this.currentWeights[page]=lerp(travel.weights[page],!travel.loading&&page===travel.destination?1:0,content);
      if(raw===1) {
        this.travel=null;
        if(travel.loading){this.waiting=true;this.loadingElapsed=0;this.loadingTick=now;this.onWaiting(true);this.invalidate();}
        else {this.current=target;this.currentWeights=weights(this.target);this.onSettled(this.target);}
      } else this.invalidate();
    } else if(this.waiting) {
      const animate=!this.reduced&&!this.studioFailed;
      if(animate&&this.loadingTick!==null)this.loadingElapsed+=now-this.loadingTick;
      this.loadingTick=animate?now:null;
      this.current={...this.current,nodes:studioLoadingNodes(this.loadingElapsed,{x:innerWidth/2,y:innerHeight/2})};
      if(animate)this.invalidate();
    } else {this.current=target;this.currentWeights=weights(this.target);}
    this.paint();
  };
  private attribute(element:Element,name:string,value:string) {
    let previous=this.painted.get(element);if(!previous){previous=new Map();this.painted.set(element,previous);}
    if(previous.get(name)===value)return;
    element.setAttribute(name,value);previous.set(name,value);
  }
  private paint() {
    if(!this.current||!this.elements)return;
    const {root,path,outside,guides,guideCrosses,fill,halo,blur}=this.elements,v=this.current;
    const viewport=`${innerWidth},${innerHeight}`;
    if(this.pathNodes!==v.nodes||this.guideViewport!==viewport) {
      const guidePaths=frameGuidePaths(v.nodes,innerWidth,innerHeight);
      this.guideData=guidePaths.lines;this.guideCrossData=guidePaths.crosses;this.guideViewport=viewport;
    }
    if(this.pathNodes!==v.nodes){this.pathNodes=v.nodes;this.pathData=framePath(v.nodes);}
    if(guides)this.attribute(guides,'d',this.guideData);
    if(guideCrosses)this.attribute(guideCrosses,'d',this.guideCrossData);
    this.attribute(path,'d',this.pathData);
    if(outside)this.attribute(outside,'d',`M 0 0 H ${innerWidth} V ${innerHeight} H 0 Z ${this.pathData}`);
    this.attribute(fill,'fill',v.fill);
    this.attribute(halo,'display',v.halo.opacity>0?'inline':'none');
    this.attribute(halo,'opacity',String(v.halo.opacity));
    if(v.halo.opacity>0) {
      // Expand the vector before blurring. Pixel dilation (feMorphology) was
      // the measured frame bottleneck; the shared contour stays full resolution.
      this.attribute(halo,'fill',v.halo.color);this.attribute(halo,'stroke',v.halo.color);
      this.attribute(halo,'stroke-width',String(Math.max(0,v.halo.spread)*2));
      this.attribute(blur,'stdDeviation',String(v.halo.blur));
    }
    const previous=this.painted.get(root);
    if(previous?.get('ground')!==v.ground){root.style.backgroundColor=v.ground;if(!previous)this.painted.set(root,new Map());this.painted.get(root)!.set('ground',v.ground);}
    const phase=this.waiting?'waiting':this.travel||this.pending?'moving':'settled';
    if(root.dataset.frameRoute!==this.target)root.dataset.frameRoute=this.target;
    if(root.dataset.framePhase!==phase)root.dataset.framePhase=phase;
    for(const [page,host]of this.hosts) {
      const amount=this.currentWeights[page];
      const visible=amount>0||page===this.target;
      const interactive=page===this.target&&amount>.5&&!this.travel&&!this.pending&&!this.waiting;
      const prior=this.hostStates.get(host);
      if(prior?.amount!==amount)host.style.opacity=String(amount);
      if(prior?.visible!==visible){host.dataset.frameVisible=String(visible);host.style.visibility=visible?'visible':'hidden';}
      if(prior?.interactive!==interactive){host.style.pointerEvents=interactive?'auto':'none';host.inert=!interactive;host.setAttribute('aria-hidden',String(!interactive));}
      this.hostStates.set(host,{amount,visible,interactive});
    }
  }
}

const FrameContext=createContext<FrameDriver|null>(null);
export function FrameProvider({driver,children}:{driver:FrameDriver;children:ReactNode}) {return <FrameContext.Provider value={driver}>{children}</FrameContext.Provider>;}
export function useFrameInvalidation() {const driver=useContext(FrameContext);return driver?.invalidate??(()=>{});}
export function useFrameSource(page:FrameRoute,source:()=>FrameVisual|null) {
  const driver=useContext(FrameContext),read=useRef(source);read.current=source;
  useLayoutEffect(()=>driver?.register(page,()=>read.current()),[driver,page]);
}
function assignRef<T>(ref:Ref<T>|undefined,value:T|null) {if(typeof ref==='function')ref(value);else if(ref)ref.current=value;}

/** A native content window references the same viewport contour. Only its clip
 * is localized; its DOM, scroll state, video and WebGL renderer stay in place. */
export const FrameWindow=forwardRef<HTMLDivElement,HTMLAttributes<HTMLDivElement>&{vignette?:boolean}>(function FrameWindow({children,vignette=false,className='',...props},ref) {
  const driver=useContext(FrameContext),anchor=useRef<HTMLDivElement|null>(null),clip=useRef<SVGUseElement>(null),shade=useRef<SVGUseElement>(null),blur=useRef<SVGFEGaussianBlurElement>(null);
  const id=useId().replace(/:/g,'');
  useLayoutEffect(()=>{
    const element=anchor.current;if(!element||!driver)return;
    let previous='';
    const measure=()=>{const r=element.getBoundingClientRect();const key=`${r.left},${r.top},${r.width},${r.height}`;if(key===previous)return;previous=key;const transform=`translate(${-r.left} ${-r.top})`;clip.current?.setAttribute('transform',transform);shade.current?.setAttribute('transform',transform);blur.current?.setAttribute('stdDeviation',String(r.width/1000*44));};
    const page=element.closest<HTMLElement>('[data-frame-page]')?.dataset.framePage as FrameRoute|undefined;
    const unwatch=driver.watchWindow(page,measure);
    const observer=new ResizeObserver(()=>driver.invalidate(page));observer.observe(element);
    return()=>{observer.disconnect();unwatch();};
  },[driver]);
  return <div {...props} className={`${className} dynamic-frame-window`} ref={element=>{anchor.current=element;assignRef(ref,element);}}>
    <svg className="dynamic-frame-local-defs" aria-hidden="true"><defs><clipPath id={`${id}-clip`} clipPathUnits="userSpaceOnUse"><use ref={clip} href={`#${driver?.pathId}`}/></clipPath>{vignette&&<filter id={`${id}-shade`} x="-30%" y="-50%" width="160%" height="200%" colorInterpolationFilters="sRGB"><feGaussianBlur ref={blur} in="SourceAlpha" stdDeviation="44" result="softInterior"/><feComposite in="SourceAlpha" in2="softInterior" operator="out" result="innerEdge"/><feFlood floodColor="#000" floodOpacity=".32" result="shade"/><feComposite in="shade" in2="innerEdge" operator="in"/></filter>}</defs></svg>
    <div className="dynamic-frame-inside" style={driver?{clipPath:`url(#${id}-clip)`}:undefined}>{children}{vignette&&<svg className="dynamic-frame-vignette" aria-hidden="true"><use ref={shade} href={`#${driver?.pathId}`} fill="#000" filter={`url(#${id}-shade)`}/></svg>}</div>
  </div>;
});

/** Outside copy keeps native layout and selection while sharing the inverse
 * contour. This also keeps rules and borders from crossing the opening. */
export const FrameOutside=forwardRef<HTMLElement,HTMLAttributes<HTMLElement>&{as?:'section'|'div'}>(function FrameOutside({children,as:Tag='div',...props},ref) {
  const driver=useContext(FrameContext),anchor=useRef<HTMLElement|null>(null),clip=useRef<SVGUseElement>(null),id=useId().replace(/:/g,'');
  useLayoutEffect(()=>{const element=anchor.current;if(!driver||!element)return;let previous='';const measure=()=>{const r=element.getBoundingClientRect(),key=`${r.left},${r.top}`;if(key===previous)return;previous=key;clip.current?.setAttribute('transform',`translate(${-r.left} ${-r.top})`);};const page=element.closest<HTMLElement>('[data-frame-page]')?.dataset.framePage as FrameRoute|undefined;return driver.watchWindow(page,measure);},[driver]);
  return <Tag {...props} data-frame-outside style={{...props.style,clipPath:driver?`url(#${id}-outside)`:undefined}} ref={element=>{anchor.current=element;assignRef(ref,element);}}><svg className="dynamic-frame-local-defs" aria-hidden="true"><defs><clipPath id={`${id}-outside`} clipPathUnits="userSpaceOnUse"><use ref={clip} href={`#${driver?.pathId}-outside`} clipRule="evenodd"/></clipPath></defs></svg>{children}</Tag>;
});

export function FrameRenderer({driver}:{driver:FrameDriver}) {
  const root=useRef<HTMLDivElement>(null),path=useRef<SVGPathElement>(null),outside=useRef<SVGPathElement>(null),guides=useRef<SVGPathElement>(null),guideCrosses=useRef<SVGPathElement>(null),halo=useRef<SVGUseElement>(null),fill=useRef<SVGUseElement>(null),blur=useRef<SVGFEGaussianBlurElement>(null);
  useLayoutEffect(()=>{if(root.current&&path.current&&halo.current&&fill.current&&blur.current)return driver.attach({root:root.current,path:path.current,outside:outside.current??undefined,guides:guides.current??undefined,guideCrosses:guideCrosses.current??undefined,halo:halo.current,fill:fill.current,blur:blur.current});},[driver]);
  return <><div className="dynamic-frame-renderer" ref={root} aria-hidden="true"><svg className="dynamic-frame-artwork"><defs><path id={driver.pathId} ref={path}/><path id={`${driver.pathId}-outside`} ref={outside} fillRule="evenodd"/><filter id={`${driver.pathId}-light`} x="-70%" y="-100%" width="240%" height="300%" colorInterpolationFilters="sRGB"><feGaussianBlur ref={blur} stdDeviation="0"/></filter></defs><use ref={halo} href={`#${driver.pathId}`} strokeLinejoin="round" filter={`url(#${driver.pathId}-light)`}/><use ref={fill} href={`#${driver.pathId}`}/></svg></div><svg className="dynamic-frame-guides" aria-hidden="true"><path ref={guides} className="frame-boundary-guides"/><path ref={guideCrosses} className="frame-boundary-crosses"/></svg></>;
}
