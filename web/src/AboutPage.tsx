import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {FrameWindow, useFrameSource, useFrameInvalidation} from './DynamicFrame';
import {aboutFrameNodes} from './frameGeometry';
import PublicSiteHeader from './PublicSiteHeader';
import {UiIcon} from './UiIcon';
import {PRODUCT_DESCRIPTION, PRODUCT_LAYERS, PRODUCT_GALLERY, PRODUCT_GALLERY_NOTE, type GalleryItem} from './productDescription';
import './about.css';

// Every film keeps its own poster. Only one can play, and only on this page, in view.
function GalleryFilm({item,active,selected,requested,onSelect}:{
  item:GalleryItem;active:boolean;selected:boolean;requested:boolean;onSelect:(slug:string|null)=>void;
}) {
  const video=useRef<HTMLVideoElement>(null);
  const [playing,setPlaying]=useState(false);
  useEffect(()=>{
    const element=video.current;
    if(!element)return;
    const motion=matchMedia('(prefers-reduced-motion: reduce)');
    const connection=(navigator as Navigator & {connection?:EventTarget & {saveData?:boolean}}).connection;
    let visible=typeof IntersectionObserver==='undefined';
    const sync=()=>{
      if(active&&visible&&selected&&!document.hidden&&(requested||(!motion.matches&&!connection?.saveData))){
        void element.play().catch(()=>{});
      }else element.pause();
    };
    const observer=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(([entry])=>{
      visible=entry.isIntersecting&&entry.intersectionRatio>=.2;sync();
    },{threshold:[0,.2]});
    observer?.observe(element);sync();
    document.addEventListener('visibilitychange',sync);motion.addEventListener('change',sync);connection?.addEventListener('change',sync);
    return ()=>{observer?.disconnect();document.removeEventListener('visibilitychange',sync);motion.removeEventListener('change',sync);connection?.removeEventListener('change',sync);element.pause();};
  },[active,selected,requested]);
  return <figure className="about-film">
    <div className="about-film-screen">
      <video ref={video} className="about-gallery-video gesso-product-film" muted loop playsInline preload="none"
        poster={`/media/gallery/${item.slug}.jpg`} aria-label={`${item.product} in ${item.world}`}
        onPlaying={()=>setPlaying(true)} onPause={()=>setPlaying(false)}>
        <source src={`/media/gallery/${item.slug}.webm`} type="video/webm"/>
        <source src={`/media/gallery/${item.slug}.mp4`} type="video/mp4"/>
      </video>
      <button className="about-film-play" type="button" aria-label={`${playing?'Pause':'Play'} ${item.product} film`}
        onClick={()=>{onSelect(playing?null:item.slug); if(!playing)void video.current?.play().catch(()=>{});}}>
        <UiIcon name={playing?'pause':'play'}/>
      </button>
    </div>
    <figcaption><p className="about-gallery-caption">{item.product}<span>{item.world}</span></p>
      <p className="about-gallery-credit">{item.credit}</p></figcaption>
  </figure>;
}

export default function AboutPage({active=true}:{active?:boolean}) {
  const root=useRef<HTMLDivElement>(null);
  const frame=useRef<{width:number;height:number;ground:string;fill:string}|null>(null);
  const [featured,...gallery]=PRODUCT_GALLERY;
  const [playback,setPlayback]=useState<{slug:string|null;requested:boolean}>({slug:featured.slug,requested:false});
  const invalidate=useFrameInvalidation();
  useFrameSource('about',()=>{
    if(!root.current||!frame.current)return null;
    const {width,height,ground,fill}=frame.current;
    return {nodes:aboutFrameNodes(width,height),ground,fill,halo:{color:ground,blur:0,spread:0,opacity:0}};
  });
  useLayoutEffect(()=>{
    const element=root.current;
    if(!element)return;
    const measure=()=>{
      if(!element.clientWidth||!element.clientHeight)return;
      const styles=getComputedStyle(element);
      frame.current={width:element.clientWidth,height:element.clientHeight,
        ground:styles.getPropertyValue('--about-ground').trim(),fill:styles.getPropertyValue('--about-surface').trim()};
      invalidate('about');
    };
    const observer=new ResizeObserver(measure);observer.observe(element);measure();
    return ()=>observer.disconnect();
  },[active,invalidate]);
  useLayoutEffect(()=>{
    if(!active)return;
    // The retained route resets its scrollport on entry. Restore an explicit
    // destination after that reset and the shell's default heading focus.
    let frame=0;
    const follow=()=>{
      cancelAnimationFrame(frame);
      const hash=location.hash;
      if(!/^\/about\/?$/.test(location.pathname)||
        !['#about-title','#about-process-title','#about-gallery-title'].includes(hash))return;
      frame=requestAnimationFrame(()=>{
        const target=root.current?.querySelector<HTMLElement>(hash);
        target?.scrollIntoView({block:'start',behavior:'instant'});target?.focus({preventScroll:true});
      });
    };
    follow();window.addEventListener('hashchange',follow);
    return ()=>{cancelAnimationFrame(frame);window.removeEventListener('hashchange',follow);};
  },[active]);
  const film=(item:GalleryItem)=><GalleryFilm item={item} active={active} selected={playback.slug===item.slug}
    requested={playback.requested} onSelect={slug=>setPlayback({slug,requested:true})}/>;
  return <div ref={root} className="gesso-about" inert={!active} aria-hidden={!active}>
    <a data-frame-outside className="about-skip" href="#about-title">Skip to product description</a>
    <div data-frame-outside className="about-header"><PublicSiteHeader current="about"/></div>
    <FrameWindow className="about-window" role="main" aria-label="About Gesso">
      <div className="about-scroll" data-frame-scroll role="region" aria-label="Product description" tabIndex={0}>
        <div className="about-description">
          <section className="about-intro" aria-labelledby="about-title">
            <div className="about-intro-copy">
              <h1 id="about-title" tabIndex={-1}>{PRODUCT_DESCRIPTION.title.replace('image-making','image‑making')}</h1>
              {PRODUCT_DESCRIPTION.paragraphs.map(text=><p key={text}>{text}</p>)}
            </div>
            {film(featured)}
          </section>
          <section className="about-process" aria-labelledby="about-process-title">
            <h2 id="about-process-title" tabIndex={-1}>Build the scene</h2>
            <dl className="about-layers">{PRODUCT_LAYERS.map(layer=><div key={layer.name}>
              <dt>{layer.name}</dt><dd>{layer.text}</dd>
            </div>)}</dl>
          </section>
          <section className="about-gallery-section" aria-labelledby="about-gallery-title">
            <div className="about-section-head"><h2 id="about-gallery-title" tabIndex={-1}>Made with Gesso</h2><p>{PRODUCT_GALLERY_NOTE}</p></div>
            <ul className="about-gallery">{gallery.map(item=><li key={item.slug}>{film(item)}</li>)}</ul>
          </section>
          <footer className="about-endnote">
            <a href="/aperture">Form + light</a>
            <a data-studio-resume href="/?step=product&layer=model">Enter studio</a>
          </footer>
        </div>
      </div>
    </FrameWindow>
  </div>;
}
