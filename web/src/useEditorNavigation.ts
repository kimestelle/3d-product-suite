import {useCallback, useEffect, useRef, useState} from 'react';
import {defaultLayers, editorDestinationUrl, layers, readEditorDestination, readEditorMode, type EditorDestination, type EditorGroup, type EditorMode} from './navigation';

import {pushFrameHistory} from './frameHistory';

type EditorLocation = EditorDestination & {mode:EditorMode};
const currentUrl = () => window.location.pathname + window.location.search + window.location.hash;
const isEditorialRoute = () => /^\/(landing|about|aperture)\/?$/.test(window.location.pathname);
const readLocation = ():EditorLocation => ({...readEditorDestination(window.location.href),mode:readEditorMode(window.location.href)});
const sameWindow = (a:EditorLocation, b:EditorLocation) => a.group===b.group&&a.layer===b.layer&&a.mode===b.mode;

/** Navigation changes the editor window without remounting the scene or its edit history. */
export function useEditorNavigation() {
  const [destination, setDestination] = useState(readLocation);
  const current = useRef(destination);
  const remembered = useRef({...defaultLayers, [destination.group]: destination.layer});
  const apply = useCallback((next:EditorLocation) => {
    current.current = next;
    remembered.current[next.group] = next.layer;
    setDestination(previous => sameWindow(previous, next) ? previous : next);
  }, []);

  useEffect(() => {
    const restore = () => {
      // Editorial routes own their history entries; do not append studio query state on Back.
      if (isEditorialRoute()) return;
      const next = readLocation();
      const url = editorDestinationUrl(window.location.href, next, next.mode);
      // Normalization replaces the current entry; Back never creates another one.
      if (url !== currentUrl()) window.history.replaceState(window.history.state, '', url);
      apply(next);
    };
    window.addEventListener('popstate', restore);
    window.addEventListener('gesso:locationchange', restore);
    restore();
    return () => {window.removeEventListener('popstate', restore);window.removeEventListener('gesso:locationchange', restore);};
  }, [apply]);

  const navigate = useCallback((group:EditorGroup, layer=remembered.current[group]) => {
    if (isEditorialRoute() || !layers[group]?.includes(layer)) return;
    const next = {group, layer, mode:current.current.mode};
    const url = editorDestinationUrl(window.location.href, next, next.mode);
    if (url !== currentUrl()) pushFrameHistory(url);
    apply(next);
    window.dispatchEvent(new Event('gesso:locationchange'));
  }, [apply]);
  const setMode = useCallback((mode:EditorMode) => {
    if(isEditorialRoute() || mode!=='still'&&mode!=='video')return;
    const next = {...current.current,mode};
    const url = editorDestinationUrl(window.location.href, next, mode);
    if (url !== currentUrl()) pushFrameHistory(url);
    apply(next);
    window.dispatchEvent(new Event('gesso:locationchange'));
  }, [apply]);
  const chooseGroup = useCallback((group:EditorGroup) => navigate(group), [navigate]);
  const chooseLayer = useCallback((layer:string) => navigate(current.current.group, layer), [navigate]);
  return {tab:destination.group, layer:destination.layer, mode:destination.mode, setMode, navigate, chooseGroup, chooseLayer};
}
