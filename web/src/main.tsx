import React, {useLayoutEffect, type ComponentType} from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './compact-panels.css';
import './condensed-editor.css';
import './keyframe-editor.css';
import './interface-system.css';
import './editor-controls.css';
import './film-viewport-controls.css';
import './focus-system.css';
import { loadStudioFonts, loadInterfaceFonts } from './fonts';

// The initial HTML owns loading feedback while modules and fonts are fetched.
// Keep it through the frame renderer's first paint before revealing React.
function CommittedEntry({App}: {App:ComponentType}) {
  useLayoutEffect(() => {
    let second=0;
    const first=requestAnimationFrame(() => {
      second=requestAnimationFrame(() => {
        document.getElementById('gesso-boot')?.remove();
        document.getElementById('gesso-boot-style')?.remove();
        window.dispatchEvent(new Event('gesso:boot-complete'));
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  return <App/>;
}

function entryFailed(error:unknown) {
  console.error('Could not open gesso.', error);
  window.dispatchEvent(new Event('gesso:boot-error'));
}

const publicPage = /^\/(landing|about|aperture)\/?$/.test(location.pathname);
const entry = /^\/curves\/?$/.test(location.pathname)
  ? new URLSearchParams(location.search).get('study')==='logo' ? import('./LogoStudy')
    : new URLSearchParams(location.search).get('compare')==='1' ? import('./CurveComparisonDemo') : import('./CurveDemo')
  : publicPage ? import('./PublicEntry') : import('./App');
const fonts = Promise.all([publicPage ? undefined : loadStudioFonts(), loadInterfaceFonts()]).catch(error => console.warn(error));
Promise.all([fonts, entry]).then(([, {default: App}]) => {
  createRoot(document.getElementById('root')!, {onUncaughtError:entryFailed})
    .render(<React.StrictMode><CommittedEntry App={App}/></React.StrictMode>);
}).catch(entryFailed);
