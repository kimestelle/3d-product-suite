import {useEffect,useRef,useState} from 'react';
import {exportDownloadUrl,exportFormats,primaryExportArtifact,type ExportArtifact,type ExportJob,type ExportMode} from './exportModel';
import './export-artifact.css';

export type ExportReview={job:ExportJob;source:unknown;mode:ExportMode;visible:boolean};
/** A successful selection opens once. Polling must not reopen a review the user
 * dismissed; a new render attempt or explicit Review action can open it again. */
export function selectExportReview(previous:ExportReview|null,job:ExportJob|null,source:unknown,mode:ExportMode,open=false):ExportReview|null {
  if(!job)return null;
  if(!previous||previous.source!==source||previous.mode!==mode||previous.job.id!==job.id||!!previous.job.paired!==!!job.paired)
    return {job,source,mode,visible:job.state==='succeeded'};
  const visible=job.state==='succeeded'&&(open||previous.job.state!=='succeeded'||previous.visible);
  if(previous.job===job&&previous.visible===visible)return previous;
  return {job,source,mode,visible};
}

type ReviewFile={artifact:ExportArtifact;kind:'image'|'video'|'archive';label:string;poster?:ExportArtifact};
/** Only server-owned immutable job files enter the media viewer. Never embed a
 * provider URL, download query, external resource or a file still being written. */
export function isReviewArtifactUrl(url:string):boolean {
  return /^\/api\/(?:jobs|comparison-renders)\/[a-zA-Z0-9_-]+\/files\/(?:[ab]\/)?(?:still(?:-\d+)?\.(?:png|jpg|webp)|film\.(?:mp4|mov)|contact-sheet\.png|frames\.zip|pair\.zip)$/.test(url);
}
export function exportReviewFiles(job:ExportJob):ReviewFile[] {
  if(job.state!=='succeeded')return [];
  const available=job.artifacts.filter(file=>isReviewArtifactUrl(file.url));
  const result:ReviewFile[]=[];
  for(const file of available){
    const base=file.name.split('/').at(-1)!,side=file.name.startsWith('a/')?'A · ':file.name.startsWith('b/')?'B · ':'';
    if(/^still\.(png|jpg|webp)$/.test(base))result.push({artifact:file,kind:'image',label:`${side}Rendered still`});
    if(/^film\.(mp4|mov)$/.test(base))result.push({artifact:file,kind:'video',label:`${side}Rendered film`,poster:available.find(item=>item.name===`${file.name.slice(0,-base.length)}contact-sheet.png`)});
  }
  if(result.length)return result;
  const sheet=available.find(file=>file.name==='contact-sheet.png');
  if(sheet)return [{artifact:sheet,kind:'image',label:'Rendered contact sheet'}];
  const archive=primaryExportArtifact(job);
  return archive&&isReviewArtifactUrl(archive.url)?[{artifact:archive,kind:'archive',label:'Rendered files'}]:[];
}

export interface ExportArtifactPreviewProps {job:ExportJob;currentDigest:string;onBack:()=>void}
export default function ExportArtifactPreview({job,currentDigest,onBack}:ExportArtifactPreviewProps){
  const files=exportReviewFiles(job),[selected,setSelected]=useState(0),[zoom,setZoom]=useState(false),[error,setError]=useState(''),[loadedUrl,setLoadedUrl]=useState<string|null>(null);
  const back=useRef<HTMLButtonElement>(null),videoRef=useRef<HTMLVideoElement>(null);
  const file=files[Math.min(selected,Math.max(0,files.length-1))];
  const mediaReady=!!file&&loadedUrl===file.artifact.url;
  const mediaUrl=useRef(file?.artifact.url);mediaUrl.current=file?.artifact.url;
  const acceptMedia=(url:string,update:()=>void)=>{if(mediaUrl.current===url)update();};
  useEffect(()=>{setSelected(0);setZoom(false);setError('');back.current?.focus({preventScroll:true});},[job.id,job.paired]);
  useEffect(()=>{
    const video=videoRef.current;if(!video||typeof document==='undefined')return;
    const hidden=()=>{if(document.hidden)video.pause();};
    document.addEventListener('visibilitychange',hidden);
    return()=>{document.removeEventListener('visibilitychange',hidden);video.pause();};
  },[file?.artifact.url,error]);
  const description=[job.width&&job.height?`${job.width} × ${job.height}`:'',job.kind==='still'?`Frame ${job.frame??1}`:`${job.fps??'—'} fps`,job.samples?`${job.samples} samples`:''].filter(Boolean).join(' · ');
  const format=exportFormats[job.format??(job.kind==='still'?'png':'mp4')].label;
  return <section className="gesso-artifact-review" aria-label="Rendered output review" onKeyDown={event=>{
    event.stopPropagation();if(event.key==='Escape'){event.preventDefault();onBack();}
  }}>
    <header className="gesso-artifact-toolbar">
      <div><strong>{job.filename||'gesso'} · {format}</strong><span>Cycles render · {description}</span>
        {job.sourceDigest&&job.sourceDigest!==currentDigest&&<span className="gesso-feedback" data-tone="note">Earlier scene revision</span>}
      </div>
      <div className="gesso-artifact-actions">
        {files.length>1&&<label>Output<select aria-label="Rendered environment" value={selected} onChange={event=>{setSelected(Number(event.target.value));setError('');setZoom(false);}}>{files.map((value,index)=><option key={value.artifact.url} value={index}>{value.label}</option>)}</select></label>}
        {file?.kind==='image'&&!error&&<button type="button" aria-pressed={zoom} onClick={()=>setZoom(value=>!value)}>{zoom?'Fit image':'Actual size'}</button>}
        {file&&<a href={exportDownloadUrl(file.artifact.url)} download={file.artifact.downloadName}>Download {file.kind==='archive'?format:file.kind==='image'?'image':'film'} ↓</a>}
        <button ref={back} type="button" onClick={onBack}>Back to editable preview</button>
      </div>
    </header>
    <div className={`gesso-artifact-media${zoom?' is-actual-size':''}`} tabIndex={0} aria-label="Rendered media" aria-busy={!!file&&file.kind!=='archive'&&!mediaReady&&!error}>
      {file?.kind==='image'&&!error&&<img key={file.artifact.url} src={file.artifact.url} alt={file.label} decoding="async" onLoad={()=>acceptMedia(file.artifact.url,()=>setLoadedUrl(file.artifact.url))} onError={()=>acceptMedia(file.artifact.url,()=>setError('The rendered image could not be opened. Download the file or return to editable preview.'))}/>}
      {file?.kind==='video'&&!error&&<video ref={videoRef} key={file.artifact.url} src={file.artifact.url} controls playsInline preload="metadata" poster={file.poster?.url} aria-label={file.label} onLoadedMetadata={()=>acceptMedia(file.artifact.url,()=>setLoadedUrl(file.artifact.url))} onError={()=>acceptMedia(file.artifact.url,()=>setError('This browser cannot play the rendered film. Download it to open in a compatible player.'))} />}
      {file&&file.kind!=='archive'&&!mediaReady&&!error&&<span className="gesso-artifact-opening" role="status">Opening rendered {file.kind==='image'?'image':'film'}…</span>}
      {file?.kind==='archive'&&<div className="gesso-artifact-message"><strong>{format}</strong><p>These rendered frames are packaged as an archive. Download the files to inspect the sequence.</p></div>}
      {!file&&<div className="gesso-artifact-message"><p>No completed media file is available for in-app review. Use the export downloads or return to preview.</p></div>}
      {error&&<div className="gesso-artifact-message" role="alert"><p>{error}</p>{file?.poster&&<img src={file.poster.url} alt="Rendered contact sheet"/>}</div>}
    </div>
  </section>;
}
