import {choosePhilosophyStop,createScrollSettle,scrollSettlePosition,type ScrollSettle} from './philosophyMotion';

export const PHILOSOPHY_SETTLE_QUERY='(min-width: 901px) and (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)';
type Options={stops:()=>readonly number[];schedule:()=>void};

/** Native input owns the gesture. Only a nearby stop ahead is approached, using
 * the page's existing RAF and real scrollTop. No wheel interception, second
 * visual playhead, or competing CSS snap animation. */
export function createPhilosophyScroll(root:HTMLElement,{stops,schedule}:Options) {
  const policy=matchMedia(PHILOSOPHY_SETTLE_QUERY);
  const hasScrollEnd='onscrollend' in root;
  const fallbackQuiet=80;
  let plan:ScrollSettle|null=null,timer=0,armed=false,heldKey=false,pointerDown=false,nativeEnded=false,writing=false;
  let origin=root.scrollTop,lastY=origin,lastSample=0,lastInput=0,velocity=0;
  const clearTimer=()=>{window.clearTimeout(timer);timer=0;};
  const cancel=()=>{plan=null;armed=false;nativeEnded=false;velocity=0;clearTimer();};
  const enabled=()=>policy.matches&&!document.hidden;
  const queue=(delay:number)=>{clearTimer();timer=window.setTimeout(settle,delay);};
  const settle=()=>{
    timer=0;
    if(!armed||plan||!enabled()||heldKey||pointerDown)return;
    if(hasScrollEnd&&!nativeEnded)return;
    const now=performance.now();
    // scrollend already means the gesture and native momentum have finished.
    // Another debounce here creates a visible stop before the settle starts.
    if(!hasScrollEnd){
      const quiet=now-Math.max(lastInput,lastSample);
      if(quiet<fallbackQuiet){queue(fallbackQuiet-quiet);return;}
    }
    armed=false;
    if(window.getSelection()?.isCollapsed===false)return;
    const position=root.scrollTop,maximum=Math.max(0,root.scrollHeight-root.clientHeight);
    const releaseVelocity=velocity*Math.exp(-Math.max(0,now-lastSample)/120);
    const destination=choosePhilosophyStop(position,releaseVelocity,origin,stops(),maximum);
    if(Math.abs(destination-position)<=.5)return;
    plan=createScrollSettle(position,destination,releaseVelocity,now);schedule();
  };
  const begin=()=>{
    if(!enabled())return;
    const now=performance.now();
    // Passive wheel delivery may follow the compositor's position update.
    // Keep the last observed offset so the first delta is not swallowed.
    if(plan||!armed||now-lastInput>240){origin=lastY;lastSample=now;velocity=0;}
    plan=null;clearTimer();armed=true;nativeEnded=false;lastInput=now;
  };
  const wheel=(event:WheelEvent)=>{
    if(event.ctrlKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)||!event.deltaY){cancel();return;}
    begin();
    if(!hasScrollEnd)queue(fallbackQuiet);
  };
  const scroll=()=>{
    // Our own scroll events may arrive after the write, or synchronously in a
    // host. Any different native offset means momentum/input has taken over.
    if(plan&&!writing&&Math.abs(root.scrollTop-lastY)>.5)cancel();
    if(!armed||plan){lastY=root.scrollTop;lastSample=performance.now();return;}
    nativeEnded=false;
    const now=performance.now(),y=root.scrollTop,dy=y-lastY;
    if(dy){
      const dt=Math.max(16,Math.min(120,now-lastSample));
      const next=Math.max(-4,Math.min(4,dy/dt));
      velocity=Math.sign(next)!==Math.sign(velocity)?next:velocity+(next-velocity)*(1-Math.exp(-dt/45));
      lastSample=now;lastY=y;
    }
    if(!hasScrollEnd)queue(fallbackQuiet);
  };
  const scrollEnd=()=>{nativeEnded=true;if(armed&&!plan)settle();};
  const keyDown=(event:KeyboardEvent)=>{
    cancel();
    // Preserve fine reading, focus, Find and Home/End. Paging is a section gesture.
    if(!['PageDown','PageUp'].includes(event.key)||event.ctrlKey||event.metaKey||event.altKey)return;
    if((event.target as Element)?.closest('input,textarea,select,[contenteditable="true"]'))return;
    heldKey=true;begin();
  };
  const keyUp=(event:KeyboardEvent)=>{
    if(!['PageDown','PageUp'].includes(event.key))return;
    heldKey=false;if(armed&&(!hasScrollEnd||nativeEnded))settle();
  };
  const pointerStart=()=>{pointerDown=true;cancel();};
  const pointerEnd=()=>{pointerDown=false;if(armed&&(!hasScrollEnd||nativeEnded))settle();};
  const blur=()=>{heldKey=false;pointerDown=false;cancel();};
  const visibility=()=>{if(document.hidden)blur();};
  const focus=()=>cancel();
  root.addEventListener('wheel',wheel,{passive:true});
  root.addEventListener('scroll',scroll,{passive:true});
  root.addEventListener('scrollend',scrollEnd);
  root.addEventListener('keydown',keyDown);
  root.addEventListener('pointerdown',pointerStart,{passive:true});
  root.addEventListener('focusin',focus);
  window.addEventListener('keyup',keyUp);
  window.addEventListener('pointerup',pointerEnd,{passive:true});
  window.addEventListener('pointercancel',pointerEnd,{passive:true});
  window.addEventListener('blur',blur);
  document.addEventListener('visibilitychange',visibility);
  policy.addEventListener('change',cancel);
  return {
    cancel,
    /** Called before the page samples scrollTop; true requests another frame. */
    advance(now:number){
      if(!plan)return false;
      if(!enabled()||Math.abs(root.scrollTop-lastY)>.5){cancel();return false;}
      const finished=now>=plan.start+plan.duration;
      writing=true;
      try{root.scrollTo({top:finished?plan.to:scrollSettlePosition(plan,now),behavior:'instant'});}
      finally{writing=false;}
      lastY=root.scrollTop;lastSample=now;
      if(finished)plan=null;
      return !finished;
    },
    dispose(){
      cancel();
      root.removeEventListener('wheel',wheel);root.removeEventListener('scroll',scroll);
      root.removeEventListener('scrollend',scrollEnd);root.removeEventListener('keydown',keyDown);
      root.removeEventListener('pointerdown',pointerStart);root.removeEventListener('focusin',focus);
      window.removeEventListener('keyup',keyUp);window.removeEventListener('pointerup',pointerEnd);
      window.removeEventListener('pointercancel',pointerEnd);
      window.removeEventListener('blur',blur);
      document.removeEventListener('visibilitychange',visibility);policy.removeEventListener('change',cancel);
    },
  };
}
