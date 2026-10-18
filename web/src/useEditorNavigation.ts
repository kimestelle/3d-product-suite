import {useCallback, useEffect, useRef, useState} from 'react';
import {defaultLayers, editorDestinationUrl, layers, readEditorDestination, readEditorMode, type EditorDestination, type EditorGroup, type EditorMode} from './navigation';

type EditorLocation = EditorDestination & {mode:EditorMode};
const currentUrl = () => window.location.pathname + window.location.search + window.location.hash;
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
      const next = readLocation();
      const url = editorDestinationUrl(window.location.href, next, next.mode);
      // Normalization replaces the current entry; Back never creates another one.
      if (url !== currentUrl()) window.history.replaceState(window.history.state, '', url);
      apply(next);
    };
    window.addEventListener('popstate', restore);
    restore();
    return () => window.removeEventListener('popstate', restore);
  }, [apply]);

  const navigate = useCallback((group:EditorGroup, layer=remembered.current[group]) => {
    if (!layers[group]?.includes(layer)) return;
    const next = {group, layer, mode:current.current.mode};
    const url = editorDestinationUrl(window.location.href, next, next.mode);
    if (url !== currentUrl()) window.history.pushState(window.history.state, '', url);
    apply(next);
  }, [apply]);
  const setMode = useCallback((mode:EditorMode) => {
    if(mode!=='still'&&mode!=='video')return;
    const next = {...current.current,mode};
    const url = editorDestinationUrl(window.location.href, next, mode);
    if (url !== currentUrl()) window.history.pushState(window.history.state, '', url);
    apply(next);
  }, [apply]);
  const chooseGroup = useCallback((group:EditorGroup) => navigate(group), [navigate]);
  const chooseLayer = useCallback((layer:string) => navigate(current.current.group, layer), [navigate]);
  return {tab:destination.group, layer:destination.layer, mode:destination.mode, setMode, navigate, chooseGroup, chooseLayer};
}
