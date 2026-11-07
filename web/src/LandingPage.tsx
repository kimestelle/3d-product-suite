import {useLayoutEffect, useRef, useState} from 'react';
import {useFrameSource, useFrameInvalidation} from './DynamicFrame';
import {roundedFrameNodes} from './frameGeometry';
import {PAGE_SCROLL_RESET_EVENT} from './pageScroll';
import PublicSiteHeader from './PublicSiteHeader';
import {landingWorlds} from './landingWorlds';
import LandingProjection, {type ProjectionMotion} from './LandingProjection';
import LandingFinishProof from './LandingFinishProof';
import LandingFilm from './LandingFilm';
import {landingScrollPose,landingScrollStep} from './landingScroll';
import './landing.css';

const cards=[
  {type:'world',label:'Blue studio'},
  {type:'world',label:'Velvet curtain'},
  {type:'world',label:'Concrete atrium'},
  {type:'finish',label:'Blue dial'},
  {type:'finish',label:'Green dial'},
  {type:'film',label:'The Film workspace'},
] as const;
const chapters={
  world:{title:<>Set up the product once.<br/>Keep making with it.</>,description:'Make images and films from your 3D product model. Choose the setting, materials and camera.'},
  finish:{title:<>Compare finishes without resetting the shot.</>,description:'The case, strap, lighting and camera stay in place.'},
  film:{title:<>Make stills and films from the same scene.</>,description:'Arrange camera moves into a sequence, then render the film. Reopen the scene when a shot needs changing.'},
};
const ground='#080808';
const shortQuery='(max-height: 520px) and (max-width: 650px)';
const initialCard=()=>location.hash==='#studio-film'?5:location.hash==='#material-edit'?3:0;

export default function LandingPage({active}:{active:boolean}) {
  const root=useRef<HTMLElement>(null);
  const track=useRef<HTMLDivElement>(null);
  const projections=useRef<Array<ProjectionMotion|null>>([]);
  const pose=useRef(landingScrollPose(0));
  const [state,setState]=useState({index:0,filmReady:false,flow:matchMedia(shortQuery).matches});
  const lastState=useRef(state);
  const invalidate=useFrameInvalidation();
  useFrameSource('landing',()=>{
    const host=root.current;
    const panel=host?.querySelector<HTMLElement>(`[data-story-card="${pose.current.index}"]`);
    const source=panel?.querySelector<HTMLElement>('[data-landing-frame]');
    if(!host||!source)return null;
    const r=source.getBoundingClientRect();
    if(!r.width||!r.height)return null;
    for(const frame of host.querySelectorAll('[data-landing-frame]'))frame.toggleAttribute('data-frame-subject',frame===source);
    const face=source.hasAttribute('data-projection-end');
    const closed=face?0:(1-pose.current.opening)/2;
    const bounds={left:r.left+r.width*closed,top:r.top+r.height*closed,right:r.right-r.width*closed,bottom:r.bottom-r.height*closed};
    return {nodes:roundedFrameNodes(bounds,face?Math.min(r.width*24/440,(bounds.right-bounds.left)/2):0),ground,
      fill:source.dataset.frameFill||(pose.current.index===5?'#242424':'#ffffff'),halo:{color:ground,opacity:0,blur:0,spread:0}};
  });

  useLayoutEffect(()=>{
    const host=root.current,journey=track.current;
    if(!host||!journey)return;
    const panels=Array.from(host.querySelectorAll<HTMLElement>('[data-story-card]'));
    const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    const short=matchMedia(shortQuery);
    const connection=(navigator as Navigator&{connection?:EventTarget&{saveData?:boolean}}).connection;
    let raf=0,step=landingScrollStep(host.clientHeight);
    function paint() {
      raf=0;
      const quiet=reduced.matches||Boolean(connection?.saveData)||short.matches;
      let progress=host!.scrollTop/step;
      if(short.matches){
        const middle=host!.getBoundingClientRect().top+host!.clientHeight*.5;
        progress=panels.map((panel,index)=>({index,r:panel.getBoundingClientRect()}))
          .sort((a,b)=>Math.abs((a.r.top+a.r.bottom)/2-middle)-Math.abs((b.r.top+b.r.bottom)/2-middle))[0]?.index??0;
      }
      const next=landingScrollPose(progress,quiet);
      pose.current=next;
      host!.dataset.storyIndex=String(next.index);
      host!.dataset.storyQuiet=String(quiet);
      host!.dataset.storyPhase=next.phase;
      host!.dataset.storyHandoff=String(next.from===2||next.from===4);
      host!.style.setProperty('--story-opening',String(next.opening));
      host!.style.setProperty('--story-inset',`${50*(1-next.opening)}%`);
      host!.style.setProperty('--story-handoff-opacity',String(Math.min(1,next.opening/.14)));
      host!.style.setProperty('--story-copy',String(next.copy));
      projections.current.forEach((projection,index)=>projection?.setOpening(index===next.index?next.opening:1));
      const focused=document.activeElement;
      if(active&&!short.matches&&panels.some((panel,index)=>index!==next.index&&focused&&panel.contains(focused)))host!.focus({preventScroll:true});
      panels.forEach((panel,index)=>{
        const visible=index===next.index||short.matches;
        panel.dataset.active=String(index===next.index);
        panel.inert=!visible;
        panel.setAttribute('aria-hidden',String(!visible));
      });
      const filmReady=active&&next.index===5&&next.opening>.98;
      if(lastState.current.index!==next.index||lastState.current.filmReady!==filmReady||lastState.current.flow!==short.matches){
        lastState.current={index:next.index,filmReady,flow:short.matches};setState(lastState.current);
      }
      invalidate('landing');
    }
    const schedule=()=>{if(!raf&&active&&!document.hidden)raf=requestAnimationFrame(paint);};
    function measure() {
      const previousStep=step;
      step=landingScrollStep(host!.clientHeight);
      host!.style.setProperty('--story-height',host!.clientHeight+'px');
      journey!.style.height=short.matches?'auto':host!.clientHeight+step*5.3+'px';
      if(!short.matches&&previousStep!==step)host!.scrollTop=host!.scrollTop/previousStep*step;
      paint();
    }
    const toHash=()=>{
      if(short.matches)panels[initialCard()]?.scrollIntoView({block:'start',behavior:'instant'});
      else host!.scrollTo({top:initialCard()*step,behavior:'instant'});
      paint();
    };
    const resize=new ResizeObserver(measure);
    resize.observe(host);
    // Projection drawing already invalidates its measured frame. Observing
    // its changing width here would measure the same scroll pose twice.
    for(const frame of host.querySelectorAll('[data-landing-frame]:not([data-projection-end])'))resize.observe(frame);
    measure();
    if(active)toHash();
    host.addEventListener('scroll',schedule,{passive:true});
    host.addEventListener(PAGE_SCROLL_RESET_EVENT,paint);
    window.addEventListener('hashchange',toHash);
    reduced.addEventListener('change',measure);
    short.addEventListener('change',measure);
    connection?.addEventListener('change',measure);
    document.addEventListener('visibilitychange',paint);
    return ()=>{cancelAnimationFrame(raf);resize.disconnect();host.removeEventListener('scroll',schedule);host.removeEventListener(PAGE_SCROLL_RESET_EVENT,paint);window.removeEventListener('hashchange',toHash);reduced.removeEventListener('change',measure);short.removeEventListener('change',measure);connection?.removeEventListener('change',measure);document.removeEventListener('visibilitychange',paint);};
  },[active,invalidate]);

  return <main className="gesso-landing public-landing" ref={root} data-frame-scroll data-story-index={state.index} tabIndex={0}
    aria-label="Gesso product story" inert={!active} aria-hidden={!active}>
    <a className="public-skip" href="#landing-top">Skip to the introduction</a>
    <div ref={track} className="landing-scroll-track">
      <div className="public-cover" id="landing-top">
        <PublicSiteHeader current="landing"/>
        <div className="landing-workbench">
          {cards.map((card,index)=>{
            const content=chapters[card.type];
            return <section key={card.label} data-story-card={index} data-active={state.index===index} aria-label={card.label}
              aria-hidden={!state.flow&&state.index!==index} inert={!state.flow&&state.index!==index} className={'landing-task landing-task--'+card.type}>
              <div className="landing-task-copy">
                {index===0?<h1 id="landing-title" tabIndex={-1}>{content.title}</h1>:<h2>{content.title}</h2>}
                <p>{content.description}</p>
              </div>
              <div className="landing-task-specimen">
                {card.type==='world'?<LandingProjection scene={landingWorlds[index]} active={false} motionRef={controller=>{projections.current[index]=controller;}}/>:card.type==='finish'?<LandingFinishProof finish={index===3?'blue':'green'} controls={false}/>:<LandingFilm active={active&&state.filmReady} autoPlayOnReveal/>}
                {card.type!=='film'&&<p className="landing-scene-name">{card.label}</p>}
              </div>
            </section>;
          })}
        </div>
        <footer className="landing-scroll-footer">
          <p>{state.index<3?'Scroll to change the world':state.index===3?'Scroll to change the finish':state.index===4?'Scroll into the editor':'Scroll back to compare'}</p>
          <a href="/about#about-gallery-title">More products</a>
        </footer>
      </div>
    </div>
  </main>;
}
