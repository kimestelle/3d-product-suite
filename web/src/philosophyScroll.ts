import {createScrollParticle,DEFAULT_SCROLL_TUNING,normalizeStops,normalizeScrollTuning,pushScrollParticle,stepScrollParticle,type ScrollTuning} from './philosophyScrollPhysics';
import type {ScrollDebugSnapshot} from './PhilosophyScrollDebug';

export const PHILOSOPHY_SETTLE_QUERY='(min-width: 901px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
type Options={stops:()=>readonly number[];schedule:()=>void;tuning?:()=>ScrollTuning};

/** One position and velocity drive the real scroll offset. Desktop wheel input
 * supplies impulses to that same motion; there is no scrollend/debounce handoff.
 * Touch, reduced motion, fine keyboard reading and nested controls stay native. */
export function createPhilosophyScroll(root:HTMLElement,{stops,schedule,tuning=()=>DEFAULT_SCROLL_TUNING}:Options) {
  const policy=matchMedia(PHILOSOPHY_SETTLE_QUERY);
  let particle=createScrollParticle(root.scrollTop,performance.now());
  let running=false,writing=false,pointerDown=false,lastTime=performance.now(),lastWritten=root.scrollTop;
  let target:number|null=null,force=0;
  const maximum=()=>Math.max(0,root.scrollHeight-root.clientHeight);
  const enabled=()=>policy.matches&&tuning().enabled&&!document.hidden;
  const debugTarget=(event:Event)=>Boolean((event.target as Element)?.closest?.('[data-scroll-debug]'));
  const cancel=()=>{
    particle=createScrollParticle(root.scrollTop,performance.now());
    running=false;target=null;force=0;lastWritten=root.scrollTop;lastTime=performance.now();
  };
  const skipWheel=(event:WheelEvent)=>{
    if(pointerDown||event.ctrlKey||event.metaKey||event.shiftKey||!event.cancelable||!event.deltaY||Math.abs(event.deltaX)>Math.abs(event.deltaY))return true;
    if(window.getSelection()?.isCollapsed===false)return true;
    const element=event.target as Element;
    if(element?.closest?.('input,textarea,select,[contenteditable="true"],[data-scroll-debug]'))return true;
    // A nested scrollable surface keeps its own native wheel behavior, even at
    // its edge. It must never become an unexpected impulse for the page.
    for(let node=element;node&&node!==root;node=node.parentElement!){
      if(node instanceof HTMLElement&&node.scrollHeight>node.clientHeight+1&&/(auto|scroll)/.test(getComputedStyle(node).overflowY))return true;
    }
    return false;
  };
  const wheel=(event:WheelEvent)=>{
    if(!enabled()||skipWheel(event)){if(!debugTarget(event))cancel();return;}
    const now=performance.now();
    if(Math.abs(root.scrollTop-lastWritten)>.75)cancel();
    if(!running){particle.position=root.scrollTop;lastTime=now;}
    const unit=event.deltaMode===1?16:event.deltaMode===2?root.clientHeight:1;
    const delta=event.deltaY*unit;
    // At a document edge, leave outward input to native browser behavior.
    if((root.scrollTop<=0&&delta<0)||(root.scrollTop>=maximum()-.5&&delta>0)){cancel();return;}
    event.preventDefault();
    particle=pushScrollParticle(particle,delta,now,stops(),maximum(),normalizeScrollTuning(tuning()));
    running=true;schedule();
  };
  const scroll=()=>{
    if(writing)return;
    if(Math.abs(root.scrollTop-lastWritten)>.75)cancel();
  };
  const keyDown=(event:KeyboardEvent)=>{if(!debugTarget(event))cancel();};
  const pointerStart=(event:PointerEvent)=>{if(debugTarget(event))return;pointerDown=true;cancel();};
  const pointerEnd=()=>{pointerDown=false;};
  const focus=(event:FocusEvent)=>{if(!debugTarget(event))cancel();};
  const blur=()=>{pointerDown=false;cancel();};
  const visibility=()=>{if(document.hidden)blur();};
  root.addEventListener('wheel',wheel,{passive:false});
  root.addEventListener('scroll',scroll,{passive:true});
  root.addEventListener('keydown',keyDown);
  root.addEventListener('pointerdown',pointerStart,{passive:true});
  root.addEventListener('focusin',focus);
  window.addEventListener('pointerup',pointerEnd,{passive:true});
  window.addEventListener('pointercancel',pointerEnd,{passive:true});
  window.addEventListener('blur',blur);
  document.addEventListener('visibilitychange',visibility);
  policy.addEventListener('change',cancel);
  return {
    cancel,
    seek(index:number){
      const destination=normalizeStops(stops(),maximum())[index];
      if(destination===undefined)return;
      if(!enabled()){
        cancel();root.scrollTo({top:destination,behavior:'instant'});lastWritten=root.scrollTop;schedule();return;
      }
      if(!running)particle=createScrollParticle(root.scrollTop,performance.now());
      particle.goal=destination;particle.blockedStop=null;
      lastTime=performance.now();target=destination;running=true;schedule();
    },
    snapshot():ScrollDebugSnapshot{
      const active=enabled();
      return {position:root.scrollTop,velocity:running?particle.velocity:0,force,target,
        stops:normalizeStops(stops(),maximum()),phase:!active?'native':!running?'resting':performance.now()-particle.lastInput<90?'rolling':'settling',
        enabled:active,reason:!policy.matches?'Native · compact, touch or reduced motion':!tuning().enabled?'Native scrolling':document.hidden?'Paused · page hidden':'Wheel drives the same position as the frame'};
    },
    /** The page calls this before drawing its contour and flowing its text. */
    advance(now:number){
      if(!running)return false;
      if(!enabled()||Math.abs(root.scrollTop-lastWritten)>.75){cancel();return false;}
      const result=stepScrollParticle(particle,Math.max(0,(now-lastTime)/1000),now,stops(),maximum(),normalizeScrollTuning(tuning()));
      particle=result.state;target=result.target;force=result.force;lastTime=now;
      writing=true;
      try{root.scrollTo({top:particle.position,behavior:'instant'});}finally{writing=false;}
      lastWritten=root.scrollTop;running=result.active;
      return running;
    },
    dispose(){
      cancel();root.removeEventListener('wheel',wheel);root.removeEventListener('scroll',scroll);
      root.removeEventListener('keydown',keyDown);root.removeEventListener('pointerdown',pointerStart);root.removeEventListener('focusin',focus);
      window.removeEventListener('pointerup',pointerEnd);window.removeEventListener('pointercancel',pointerEnd);window.removeEventListener('blur',blur);
      document.removeEventListener('visibilitychange',visibility);policy.removeEventListener('change',cancel);
    },
  };
}
