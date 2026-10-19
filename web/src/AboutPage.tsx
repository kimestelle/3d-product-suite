import {useLayoutEffect, useRef} from 'react';
import {FrameWindow, useFrameSource, useFrameInvalidation} from './DynamicFrame';
import {aboutFrameNodes} from './frameGeometry';
import arrowUpRight from './assets/gesso/about-nav-arrow.svg';
import {PRODUCT_DESCRIPTION, PRODUCT_LAYERS, PRODUCT_PROCESS_NOTE, PRODUCT_ENDNOTE} from './productDescription';
import './about.css';
import './site-grid.css';

export default function AboutPage({active = true}: {active?:boolean}) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<{width:number;height:number;ground:string;fill:string;light:string}|null>(null);
  const invalidate = useFrameInvalidation();
  useFrameSource('about', () => {
    if (!root.current || !frame.current) return null;
    const {width,height,ground,fill,light} = frame.current, mobile = width <= 760;
    return {nodes:aboutFrameNodes(width,height),ground,fill,
      halo:{color:light,blur:mobile?50:95,spread:mobile?24:65,opacity:mobile?.4:1}};
  });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      if (!element.clientWidth || !element.clientHeight) return;
      const styles = getComputedStyle(element);
      frame.current = {width:element.clientWidth,height:element.clientHeight,
        ground:styles.getPropertyValue('--about-ground').trim() || '#1c3e9f',
        fill:styles.getPropertyValue('--about-surface').trim() || '#131313',
        light:styles.getPropertyValue('--about-light').trim() || '#247cda'};
      invalidate('about');
    };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [active, invalidate]);
  return <div ref={root} className="gesso-about" inert={!active} aria-hidden={!active}>
    <a data-frame-outside className="about-skip" href="#about-title">Skip to product description</a>
    <header className="about-header gesso-site-header" data-frame-outside>
      <a className="about-wordmark gesso-site-wordmark" href="/landing" aria-label="gesso home">gesso</a>
      <nav className="gesso-site-nav" aria-label="Main navigation">
        <a className="site-about-link" href="#about-title" aria-current="page">about</a>
        <a className="site-study-link" href="/aperture">form + light</a>
        <a className="site-studio-link" data-studio-resume href="/?step=product&layer=model">enter studio <img src={arrowUpRight} alt="" width="14" height="20"/></a>
      </nav>
    </header>
    <FrameWindow className="about-window" role="main" aria-label="About gesso">
      <div className="about-scroll" role="region" aria-label="Product description" tabIndex={0}>
      <div className="about-description">
        <section className="about-description-row" aria-labelledby="about-title">
          <h1 id="about-title" tabIndex={-1}>{PRODUCT_DESCRIPTION.title}</h1>
          <div className="about-description-body">{PRODUCT_DESCRIPTION.paragraphs.map(text => <p key={text}>{text}</p>)}</div>
        </section>
        <section className="about-description-row" aria-labelledby="about-process-title">
          <h2 id="about-process-title">Product to film<br/>in four steps</h2>
          <div className="about-description-body">
            <dl className="about-layers">{PRODUCT_LAYERS.map((layer, index) => <div key={layer.name}>
              <dt><span>{String(index + 1).padStart(2, '0')}</span>{layer.name}</dt>
              <dd>{layer.text}</dd>
            </div>)}</dl>
            <p className="about-process-note">{PRODUCT_PROCESS_NOTE}</p>
          </div>
        </section>
        <footer className="about-description-row about-endnote">
          <div className="about-description-body"><p>{PRODUCT_ENDNOTE}</p><a data-studio-resume href="/?step=product&layer=model">enter studio <span className="about-endnote-arrow" aria-hidden="true"/></a></div>
        </footer>
      </div>
      </div>
    </FrameWindow>
  </div>;
}
