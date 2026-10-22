import {useEffect,useRef,useState} from 'react';
import './model-outline.css';

export type ModelOutlineCapture=(ids:string[],signal:AbortSignal)=>Promise<Blob>;
export default function ModelOutlinePreview({capture,revision,ready,highlightIds,name}:{capture?:ModelOutlineCapture;revision:string;ready:boolean;highlightIds:string[];name:string}) {
  const [image,setImage]=useState<{url:string;name:string;highlighted:boolean}|null>(null),[failed,setFailed]=useState(false);
  const cache=useRef(new Map<string,string>());
  const request=useRef(0);
  const key=highlightIds.join('|');
  useEffect(()=>()=>{++request.current;for(const value of cache.current.values())URL.revokeObjectURL(value);cache.current.clear();},[]);
  useEffect(()=>{
    ++request.current;for(const value of cache.current.values())URL.revokeObjectURL(value);cache.current.clear();setImage(null);setFailed(false);
  },[revision]);
  useEffect(()=>{
    if(!capture||!ready)return;
    const cached=cache.current.get(key);
    if(cached){setImage({url:cached,name,highlighted:!!highlightIds.length});setFailed(false);return;}
    const abort=new AbortController(),id=++request.current;
    // Coalesce a pointer crossing several rows; stale captures never reach the image.
    const frame=requestAnimationFrame(()=>{
      void capture(highlightIds,abort.signal).then(blob=>{
        if(abort.signal.aborted||request.current!==id)return;
        const next=URL.createObjectURL(blob);
        cache.current.set(key,next);
        if(cache.current.size>24){const oldest=cache.current.keys().next().value!;URL.revokeObjectURL(cache.current.get(oldest)!);cache.current.delete(oldest);}
        setImage({url:next,name,highlighted:!!highlightIds.length});setFailed(false);
      }).catch(()=>{if(!abort.signal.aborted&&request.current===id){setImage(null);setFailed(true);}});
    });
    return()=>{abort.abort();cancelAnimationFrame(frame);};
  },[capture,ready,revision,key,name]);
  return <figure className="gesso-model-outline" aria-label="Model wireframe preview">
    {image?<img src={image.url} alt={image.highlighted?`${image.name} highlighted in the model wireframe`:'Model wireframe'} width="320" height="200"/>:<div className="gesso-outline-placeholder">{failed?'Outline unavailable':'Loading outline…'}</div>}
    <figcaption><span>{image?.highlighted?image.name:'Model'}</span><span>Wireframe</span></figcaption>
  </figure>;
}
