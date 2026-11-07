import './public-site.css';
import {GESSO_WORDMARK as mark} from './publicWordmark';

export function SiteWordmark() {
  return <svg className="public-signature" width={mark.width} height={mark.height}
    viewBox={mark.viewBox} focusable="false" aria-hidden="true" fill="currentColor">
    <text fontFamily="'halyard-display-variable','Halyard Display',sans-serif" fontWeight={mark.weight}
      fontSize={mark.em} letterSpacing={mark.trackingEm * mark.em} x="0" y="0">gess</text>
    <path fillRule="evenodd" d={mark.ring}/>
  </svg>;
}

export default function PublicSiteHeader({current,className=''}:{
  current:'landing'|'about'|'philosophy'|'marketplace'; className?:string;
}) {
  return <header className={`public-site-header ${className}`}>
    <a className="public-home" href={current==='landing'?'#landing-top':'/landing'} aria-label="Gesso home" aria-current={current==='landing'?'page':undefined}><SiteWordmark/></a>
    <nav aria-label="Main navigation">
      <a href="/marketplace" aria-current={current==='marketplace'?'page':undefined}>Marketplace</a>
      <a href="/about" aria-current={current==='about'?'page':undefined}>About</a>
      <a href="/aperture" aria-current={current==='philosophy'?'page':undefined}>Form + light</a>
      <a className="public-enter" href="/?step=product&amp;layer=model" data-studio-resume>Enter studio</a>
    </nav>
  </header>;
}
