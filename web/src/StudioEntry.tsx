import {Component, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import LandingPage from './LandingPage';
import AboutPage from './AboutPage';
import ShapeLightPage from './ShapeLightPage';
import {FrameDriver, FrameProvider, FrameRenderer, frameContrastColor, type FrameRoute} from './DynamicFrame';
import {ensureFrameHistory,frameHistoryIndex,pushFrameHistory,restoreFrameHistory,type FrameHistoryPosition} from './frameHistory';
import {resetPageScroll} from './pageScroll';

export type StudioEditorProps = {active:boolean; onReady?:()=>void; onLoadError?:(message:string)=>void};
export const FRAME_LOCATION_EVENT='gesso:locationchange';
export function frameRoute(path:string):FrameRoute|null {
  if(/^\/landing\/?$/.test(path))return 'landing';
  if(/^\/about\/?$/.test(path))return 'about';
  if(/^\/aperture\/?$/.test(path))return 'philosophy';
  return path==='/'?'studio':null;
}
const titles:Record<FrameRoute,string>={landing:'gesso — your product, your world',about:'About — gesso',philosophy:'Form + light — gesso',studio:'gesso studio'};
const currentUrl=()=>location.pathname+location.search+location.hash;

class SceneLoadBoundary extends Component<{onError:(message:string)=>void;children:ReactNode},{failed:boolean}> {
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error:Error){this.props.onError(error.message);}
  render(){return this.state.failed?null:this.props.children;}
}

/** All destinations retain their real DOM. Navigation only retargets the one
 * displayed frame and the inside/outside content weights, in either direction. */
export default function StudioEntry({renderEditor}:{renderEditor:(props:StudioEditorProps)=>ReactNode}) {
  const initial=useRef(frameRoute(location.pathname)??'studio').current;
  const id=useId().replace(/:/g,'');
  const [driver]=useState(()=>new FrameDriver(initial,`${id}-shared-contour`));
  const [view,setView]=useState({route:initial,active:initial,busy:initial==='studio',waiting:initial==='studio'});
  const viewRef=useRef(view);viewRef.current=view;
  const [visited,setVisited]=useState<Set<FrameRoute>>(()=>new Set(initial==='studio'?[]:[initial]));
  const [attempt,setAttempt]=useState(0);
  const attemptRef=useRef(attempt);attemptRef.current=attempt;
  const [error,setError]=useState('');
  const loadError=useRef('');
  const returnFocus=useRef(new Map<FrameRoute,HTMLElement>());
  const [firstLocation]=useState<FrameHistoryPosition>(()=>({url:currentUrl(),index:ensureFrameHistory()}));
  const knownLocation=useRef(firstLocation);
  const historyReturn=useRef<FrameHistoryPosition>({url:'/landing',index:null});
  const [lastStudioUrl,setLastStudioUrl]=useState(initial==='studio'?currentUrl():'/?step=product&layer=model');
  const cancelling=useRef(false);
  const pendingFocus=useRef(false);
  const status=useRef<HTMLDivElement>(null);
  const mounted=useRef(false);

  const navigate=useCallback((href:string,push=true)=>{
    const url=new URL(href,location.href),next=frameRoute(url.pathname);
    if(!next)return;
    const prior=viewRef.current;
    const previousLocation=knownLocation.current;
    if(push&&currentUrl()!==url.pathname+url.search+url.hash)pushFrameHistory(url.pathname+url.search+url.hash);
    knownLocation.current={url:currentUrl(),index:frameHistoryIndex()};
    if(!cancelling.current&&(next!==prior.route||prior.busy))historyReturn.current=previousLocation;
    if(new URL(previousLocation.url,location.origin).pathname==='/')setLastStudioUrl(previousLocation.url);
    // The preserved studio ingests explicit destination parameters without a reload.
    window.dispatchEvent(new Event(FRAME_LOCATION_EVENT));
    if(next===prior.route&&!prior.busy)return;
    // Reset before the shared frame samples the destination. In particular,
    // Form + Light must morph to its cover, not its previously visited chapter.
    resetPageScroll(driver.hosts.get(next));
    const focused=document.activeElement;
    if(focused instanceof HTMLElement&&focused.closest(`[data-frame-page="${prior.active}"]`))returnFocus.current.set(prior.active,focused);
    if(next!=='studio')setVisited(previous=>previous.has(next)?previous:new Set([...previous,next]));
    setError(next==='studio'?loadError.current:'');pendingFocus.current=true;
    setView(previous=>({...previous,route:next,busy:true,waiting:false}));
    driver.navigate(next);
  },[driver]);

  useLayoutEffect(()=>{
    mounted.current=true;
    const previousScrollRestoration=history.scrollRestoration;
    history.scrollRestoration='manual';
    driver.onSettled=route=>{cancelling.current=false;if(mounted.current)setView({route,active:route,busy:false,waiting:false});};
    driver.onWaiting=waiting=>{if(mounted.current)setView(previous=>({...previous,waiting}));};
    if(initial==='studio')driver.navigate('studio');
    return()=>{mounted.current=false;history.scrollRestoration=previousScrollRestoration;driver.onSettled=()=>{};driver.onWaiting=()=>{};};
  },[driver,initial]);
  useEffect(()=>{
    if(view.route!=='studio'||!view.waiting||visited.has('studio'))return;
    // The small loader gets a paint before WebGL creation and model setup can
    // occupy the main thread. Cancel this mount if navigation is interrupted.
    let second=0;
    const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{
      setVisited(previous=>previous.has('studio')?previous:new Set([...previous,'studio']));
    });});
    return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);};
  },[view.route,view.waiting,visited]);
  const cancel=useCallback(()=>{
    if(cancelling.current)return;
    cancelling.current=true;
    const destination=historyReturn.current;
    if(!restoreFrameHistory(destination))navigate(destination.url,false);
  },[navigate]);
  useEffect(()=>{
    const remember=()=>{
      knownLocation.current={url:currentUrl(),index:frameHistoryIndex()};
      if(location.pathname==='/')setLastStudioUrl(currentUrl());
    };
    window.addEventListener(FRAME_LOCATION_EVENT,remember);
    return()=>window.removeEventListener(FRAME_LOCATION_EVENT,remember);
  },[]);
  useLayoutEffect(()=>{
    // Keep native new-tab/modified-click behavior consistent with ordinary clicks.
    for(const host of driver.hosts.values())for(const link of host.querySelectorAll<HTMLAnchorElement>('a[data-studio-resume]'))link.href=lastStudioUrl;
  },[driver,lastStudioUrl,visited,view.route]);
  useEffect(()=>{
    const restore=()=>navigate(currentUrl(),false);
    window.addEventListener('popstate',restore);
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||!viewRef.current.busy)return;
      event.preventDefault();cancel();
    };
    window.addEventListener('keydown',escape);
    return()=>{window.removeEventListener('popstate',restore);window.removeEventListener('keydown',escape);};
  },[navigate,cancel]);
  useLayoutEffect(()=>{
    document.title=titles[view.route];
    if(view.waiting){status.current?.focus({preventScroll:true});return;}
    if(view.busy||!pendingFocus.current)return;
    pendingFocus.current=false;
    const host=driver.hosts.get(view.route);
    // A remembered footer link would leave keyboard focus below the fresh page.
    // The editor keeps its focused control and working state.
    const restored=view.route==='studio'?returnFocus.current.get(view.route):undefined;
    const entrySelector=view.route==='landing'?'.landing-aperture-trigger, .landing-mobile-enter':view.route==='about'?'#about-title':view.route==='philosophy'?'#shape-light-title':'.viewport';
    const entry=Array.from(host?.querySelectorAll<HTMLElement>(entrySelector)??[]).find(element=>element.getClientRects().length>0);
    const preferred=restored?.isConnected?restored:entry;
    preferred?.focus({preventScroll:true});
  },[view.busy,view.route,view.waiting,driver]);
  const ready=useCallback(()=>{if(attempt===attemptRef.current){loadError.current='';setError('');driver.markReady('studio');}},[driver,attempt]);
  const failed=useCallback((message:string)=>{if(attempt===attemptRef.current){loadError.current=message;setError(message);driver.failStudio();}},[driver,attempt]);
  const retry=()=>{loadError.current='';setError('');driver.retryStudio();setAttempt(value=>value+1);};
  const intercept=(event:React.MouseEvent<HTMLDivElement>)=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    const link=(event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if(!link||link.hasAttribute('download')||(link.target&&link.target!=='_self'))return;
    const url=new URL(link.hasAttribute('data-studio-resume')?lastStudioUrl:link.href,location.href);
    if(url.origin!==location.origin||!frameRoute(url.pathname))return;
    if(url.pathname===location.pathname&&url.search===location.search&&url.hash)return;
    event.preventDefault();navigate(url.href);
  };
  const page=(route:FrameRoute,children:ReactNode)=>visited.has(route)&&<div key={route} className="dynamic-frame-page" data-frame-page={route} data-initial={route===initial} ref={element=>driver.registerHost(route,element)}>{children}</div>;
  const active=(route:FrameRoute)=>!view.busy&&view.active===route;

  return <FrameProvider driver={driver}><div className="dynamic-frame-shell" data-navigation={view.busy?'moving':'settled'} data-page={view.route} onClickCapture={intercept}>
    <FrameRenderer driver={driver}/>
    {page('landing',<LandingPage active={active('landing')}/>)}
    {page('about',<AboutPage active={active('about')}/>)}
    {page('philosophy',<ShapeLightPage active={active('philosophy')}/>)}
    {page('studio',<SceneLoadBoundary key={attempt} onError={failed}>{renderEditor({active:active('studio'),onReady:ready,onLoadError:failed})}</SceneLoadBoundary>)}
    {view.waiting&&view.route==='studio'&&<div ref={status} className="dynamic-frame-loading" tabIndex={-1} role="dialog" aria-label="Opening studio" aria-busy={!error} style={{color:frameContrastColor(driver.current?.ground??'#131313')}}>
      <div className="dynamic-frame-loading-message">
      <p role={error?'alert':'status'}>{error?'couldn’t open studio':'opening studio'}</p>
      {error&&<p className="dynamic-frame-load-error">{error}</p>}
      {error&&<button onClick={retry}>try again</button>}<button className="dynamic-frame-loading-back" onClick={cancel}><span aria-hidden="true">←</span><span>back</span></button>
      </div>
    </div>}
  </div></FrameProvider>;
}
