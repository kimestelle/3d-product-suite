import {useEffect, useState, type ComponentType} from 'react';
import StudioEntry, {type StudioEditorProps} from './StudioEntry';
import {loadStudioFonts} from './fonts';

let request: Promise<ComponentType<StudioEditorProps>> | undefined;
function loadEditor() {
  // Public visitors need the WebGL editor and its artwork fonts only when
  // entering the studio. The shared route frame owns loading and recovery.
  request ??= Promise.all([import('./App'), loadStudioFonts()])
    .then(([entry]) => entry.StudioEditor)
    .catch((error: unknown) => { request=undefined; throw error; });
  return request;
}

function DeferredEditor(props:StudioEditorProps) {
  const [Editor,setEditor]=useState<ComponentType<StudioEditorProps> | null>(null);
  const {onLoadError}=props;
  useEffect(()=>{
    let mounted=true;
    loadEditor().then(component=>{if(mounted)setEditor(()=>component);})
      .catch(()=>{if(mounted)onLoadError?.('The studio could not load. Check your connection and try again.');});
    return ()=>{mounted=false;};
  },[onLoadError]);
  return Editor ? <Editor {...props}/> : null;
}

const renderEditor=(props:StudioEditorProps)=><DeferredEditor {...props}/>;
export default function PublicEntry(){
  return <StudioEntry renderEditor={renderEditor}/>;
}
