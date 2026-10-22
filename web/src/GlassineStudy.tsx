import {forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type RefObject} from 'react';
import {FrameWindow} from './DynamicFrame';
import type {GlassineBounds, GlassineRenderer} from './glassineRenderer';
import paperUrl from './assets/gesso/glassine2.webp';
import posterUrl from './assets/gesso/glassine-still.jpg?no-inline';
import {STATIC_MOTION_QUERY} from './motionPolicy';
import {PHILOSOPHY_SCREENSHOTS} from './philosophyScreenshots';

export type GlassineFrame = {progress:number;width:number;height:number;bounds:GlassineBounds;contains:(x:number,y:number)=>boolean};
export type GlassineStudyHandle = {update:(frame:GlassineFrame)=>void};
type Connection = EventTarget & {saveData?:boolean};
type Props = {active:boolean;page:RefObject<HTMLDivElement|null>};
const REST={x:.68,y:.28};
const smooth=(value:number)=>{const t=Math.max(0,Math.min(1,value));return t*t*(3-2*t);};

/** One canvas follows the existing frame's scroll playhead. It has no geometry
 * loop: only light changes draw pixels, and offscreen/hidden pages stop work. */
export const GlassineStudy=forwardRef<GlassineStudyHandle,Props>(function GlassineStudy({active,page},ref){
  const canvas=useRef<HTMLCanvasElement>(null),windowRef=useRef<HTMLDivElement>(null);
  const frameRef=useRef<GlassineFrame|null>(null),activeRef=useRef(active);
  const notify=useRef<()=>void>(()=>{});
  useImperativeHandle(ref,()=>({update(frame){frameRef.current=frame;notify.current();}}),[]);
  useLayoutEffect(()=>{activeRef.current=active;notify.current();},[active]);
  useEffect(()=>{
    const element=canvas.current,windowElement=windowRef.current,root=page.current;
    if(!element||!windowElement||!root)return;
    const screenshots=[...windowElement.querySelectorAll<HTMLImageElement>('img.shape-light-screenshot')];
    const motion=matchMedia(STATIC_MOTION_QUERY);
    const connection=(navigator as Navigator & {connection?:Connection}).connection;
    let renderer:GlassineRenderer|null=null,loading=false,ready=false,failed=false,alive=true;
    let request=0,lastTime=0,elapsed=0,dirty=true,pointerInside=false;
    let current={...REST},target={...REST},lastDraw=-Infinity;
    let lastSize='',lastBounds='';
    let displayedStage=0;
    const stop=()=>{cancelAnimationFrame(request);request=0;lastTime=0;windowElement.dataset.running='false';};
    const visible=()=>activeRef.current&&!document.hidden&&(frameRef.current?.progress??1)<.85&&(frameRef.current?.width??0)>900;
    const still=()=>motion.matches||Boolean(connection?.saveData);
    const fail=(error:Error)=>{
      if(!alive)return;failed=true;ready=false;stop();
      windowElement.dataset.ready='false';windowElement.dataset.state='fallback';
      console.warn('Glassine is showing its still image.',error.message);
    };
    const tick=(now:number)=>{
      request=0;
      if(!visible()||!renderer||!ready){stop();return;}
      const frame=frameRef.current!;
      const dt=lastTime?Math.min(64,now-lastTime):16;lastTime=now;
      if(!still())elapsed+=dt/1000;
      if(!pointerInside){target=still()?REST:{x:.56+Math.cos(elapsed*.28)*.22,y:.34+Math.sin(elapsed*.28)*.18};}
      const blend=still()?1:1-Math.exp(-dt/110);
      current={x:current.x+(target.x-current.x)*blend,y:current.y+(target.y-current.y)*blend};
      if(dirty||now-lastDraw>=1000/30){
        renderer.draw({x:frame.bounds.x+current.x*frame.bounds.width,y:frame.bounds.y+current.y*frame.bounds.height},frame.bounds);
        dirty=false;lastDraw=now;windowElement.dataset.ready='true';
      }
      const moving=Math.abs(current.x-target.x)+Math.abs(current.y-target.y)>.0005;
      if(!still()&&(!pointerInside||moving)){windowElement.dataset.running='true';request=requestAnimationFrame(tick);}
      else {lastTime=0;windowElement.dataset.running='false';}
    };
    const wake=()=>{
      if(!visible()||failed||connection?.saveData){stop();return;}
      if(!renderer&&!loading){
        loading=true;
        void import('./glassineRenderer').then(({createGlassineRenderer})=>{
          if(!alive)return;
          renderer=createGlassineRenderer(element,{paperUrl,onReady(){if(!alive)return;ready=true;dirty=true;windowElement.dataset.state='live';notify.current();},onError:fail});
          notify.current();
        }).catch(error=>fail(error instanceof Error?error:new Error(String(error))));
      }
      if(ready&&!request)request=requestAnimationFrame(tick);
    };
    const update=()=>{
      const frame=frameRef.current;if(!frame)return;
      if(!activeRef.current)pointerInside=false;
      const fade=smooth((frame.progress-.12)/.72);
      const stage=Math.round(frame.progress);
      const chapterVisible=activeRef.current&&!document.hidden&&frame.width>900&&frame.progress>=.6;
      const requested=screenshots.find(image=>Number(image.dataset.stage)===stage);
      if(frame.progress<.6)displayedStage=0;
      else if(requested?.dataset.ready==='true')displayedStage=stage;
      const screenshotActive=chapterVisible&&displayedStage>0;
      for(const image of screenshots){
        const on=screenshotActive&&Number(image.dataset.stage)===displayedStage;
        if(on!==(image.dataset.active==='true'))image.dataset.active=String(on);
      }
      windowElement.dataset.screenshot=String(screenshotActive);
      windowElement.style.opacity=chapterVisible?'1':String(1-fade);
      // A cold or failed image keeps the previous capture, or the cover poster,
      // until its replacement has decoded. No chapter opens into an empty fill.
      if(chapterVisible&&!displayedStage)windowElement.dataset.ready='false';
      const size=`${frame.width},${frame.height},${window.devicePixelRatio}`;
      if(renderer&&size!==lastSize){renderer.resize(frame.width,frame.height);lastSize=size;dirty=true;windowElement.dataset.ready='false';}
      const b=frame.bounds,key=`${b.x},${b.y},${b.width},${b.height}`;
      if(key!==lastBounds){
        lastBounds=key;dirty=true;
        for(const fill of windowElement.querySelectorAll<HTMLElement>('.shape-light-glassine-still, .shape-light-screenshot'))
          Object.assign(fill.style,{left:`${b.x*100}%`,top:`${b.y*100}%`,width:`${b.width*100}%`,height:`${b.height*100}%`});
      }
      if(dirty||!still())wake();
      else if(!visible())stop();
    };
    notify.current=update;
    const pointer=(event:PointerEvent)=>{
      const frame=frameRef.current;if(!frame||!visible()||still()||event.pointerType==='touch')return;
      pointerInside=frame.contains(event.clientX,event.clientY);
      if(pointerInside){target={x:Math.max(0,Math.min(1,(event.clientX/frame.width-frame.bounds.x)/frame.bounds.width)),y:Math.max(0,Math.min(1,(event.clientY/frame.height-frame.bounds.y)/frame.bounds.height))};}
      wake();
    };
    const leave=()=>{pointerInside=false;wake();};
    const policy=()=>{dirty=true;pointerInside=false;if(connection?.saveData){windowElement.dataset.ready='false';windowElement.dataset.state='static';}update();};
    const restore=()=>{renderer?.dispose();renderer=null;lastSize='';loading=false;failed=false;ready=false;dirty=true;update();};
    root.addEventListener('pointermove',pointer,{passive:true});root.addEventListener('pointerleave',leave);
    document.addEventListener('visibilitychange',policy);motion.addEventListener('change',policy);connection?.addEventListener('change',policy);
    element.addEventListener('webglcontextrestored',restore);
    update();
    return()=>{
      alive=false;notify.current=()=>{};stop();renderer?.dispose();
      root.removeEventListener('pointermove',pointer);root.removeEventListener('pointerleave',leave);
      document.removeEventListener('visibilitychange',policy);motion.removeEventListener('change',policy);connection?.removeEventListener('change',policy);
      element.removeEventListener('webglcontextrestored',restore);
    };
  },[page]);
  return <FrameWindow ref={windowRef} className="shape-light-glassine" aria-hidden="true" data-ready="false" data-state="loading" data-running="false" data-screenshot="false">
    <img className="shape-light-glassine-still" src={posterUrl} alt=""/>
    <canvas ref={canvas}/>
    {PHILOSOPHY_SCREENSHOTS.map(screenshot=><img key={screenshot.id} className="shape-light-screenshot" data-stage={screenshot.stage} data-active="false" data-ready="false" src={screenshot.src} width={screenshot.width} height={screenshot.height} style={{objectPosition:screenshot.position}} alt="" loading="lazy" decoding="async" onLoad={event=>{
      const image=event.currentTarget;
      void image.decode().then(()=>{if(image.isConnected){image.dataset.ready='true';notify.current();}}).catch(()=>{});
    }}/>)}
  </FrameWindow>;
});

export {posterUrl as glassinePoster};
