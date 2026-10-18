import { useCallback, useEffect, useRef, useState } from 'react';
import { equalJson, canRedo, canUndo, commitHistory, createHistory, redoHistory, undoHistory } from './state';
import { createViewport, type ViewportPart } from './viewport';
import type {MaterialPreview} from './materials';
import { resolveHierarchy, sceneParts } from './hierarchy';
import ProductPanel, { type ProductLayer } from './ProductPanel';
import WorldPanel, { type WorldLayer } from './WorldPanel';
import FilmPanel from './FilmPanel';
import FilmViewportControls from './FilmViewportControls';
import {useFilmCamera} from './useFilmCamera';
import type {FilmGuideProjection} from './filmGuides';
import TransformShortcuts from './TransformShortcuts';
import type {TransformMode,TransformTarget} from './transforms';
import {NumberControl} from './EditorControls';
import {decalForPart, newDecal, UvDecalOverlay} from './DecalEditor';
import type {ProductDecal, UvLayout} from './decals';
import {partName} from './hierarchy';
import { groups, shortcutDestination } from './navigation';
import {useEditorNavigation} from './useEditorNavigation';
import EditorNavigation from './EditorNavigation';
import {UiIcon} from './UiIcon';
import KeyframeEditor from './KeyframeEditor';
import {materializeAnimatedPose} from './keyframes';
import avatar from './assets/gesso/avatar.png';
import ComparisonPanel, { ComparisonJobList, emptyCalibration, type CalibrationDraft, type PickRequest } from './ComparisonPanel';
import { comparisonLabels, enableComparison, setComparisonWorld, updateWorldTransform, type ComparisonMode, type Side } from './comparison';

type Scene = any;
type Project = {id:string;name:string;scene:Scene;revisionId:string;approvedRevisionId:string|null;headRevisionId?:string};
type World = {id:string;name:string;environment:Scene};
type Job = {id:string;kind:string;state:string;stage?:string;frame?:number;sourceDigest:string;completedFrames:number;totalFrames:number;error?:string;artifacts:{name:string;url:string}[]};
type PairJob = {id:string;kind:string;state:string;sourceDigest:string;sharedDigest:string;alignmentStatus:string;frame?:number;children:{a:Job;b:Job};artifacts:{name:string;url:string}[];createdAt:string;error?:string};
async function api(path:string, method='GET', data?:unknown, signal?:AbortSignal) {
  const result=await fetch(path,{method,signal,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Product-Suite':'1'},body:method==='GET'?undefined:JSON.stringify(data??{})});
  const value=await result.json(); if(!result.ok) throw new Error(value.error||`Request failed (${result.status})`); return value;
}
function Field({label,children}:{label:string;children:React.ReactNode}) {return <label className="field"><span>{label}</span>{children}</label>}
function NumberField({label,value,onChange,min,max,step=.01}:{label:string;value:number;onChange:(n:number)=>void;min?:number;max?:number;step?:number}) {return <Field label={label}><input type="number" value={Number(value.toFixed(5))} min={min} max={max} step={step} onChange={e=>{const n=Number(e.target.value);if(e.target.value!==''&&Number.isFinite(n))onChange(n)}}/></Field>}
const clone=<T,>(x:T):T=>structuredClone(x);

function Capture() {
  const host=useRef<HTMLDivElement>(null); const [error,setError]=useState('');
  useEffect(()=>{if(!host.current)return;const view=createViewport(host.current,{capture:true,onError:setError});
    (window as any).productSuiteCapture={depthOfField:'sampled-camera',load:(payload:any)=>view.loadCapture(payload),frame:(frame:number)=>view.captureFrame(frame)};
    return()=>{delete (window as any).productSuiteCapture;view.dispose()};},[]);
  return <div className="capture-root" ref={host}>{error&&<pre>{error}</pre>}</div>;
}

function Editor() {
  const [project,setProject]=useState<Project|null>(null); const [projects,setProjects]=useState<any[]>([]);
  const [history,setHistory]=useState(()=>createHistory<Scene|null>(null)); const scene=history.present;
  const [worlds,setWorlds]=useState<World[]>([]);const [jobs,setJobs]=useState<Job[]>([]);
  const [pairJobs,setPairJobs]=useState<PairJob[]>([]);const [comparisonInfo,setComparisonInfo]=useState<any>(null);const [comparisonMode,setComparisonMode]=useState<ComparisonMode>('split');
  const [calibrationDrafts,setCalibrationDrafts]=useState<Record<Side,CalibrationDraft>>({a:emptyCalibration(),b:emptyCalibration()});const [picking,setPicking]=useState<PickRequest>(null);
  const [caps,setCaps]=useState<any>({}); const [samples,setSamples]=useState<any[]>([]);const [digest,setDigest]=useState('');
  const [frame,setFrame]=useState(1);const [playing,setPlaying]=useState(false); const [selected,setSelected]=useState<string|null>('bottle-body');
  const [error,setError]=useState('');const [validationError,setValidationError]=useState(''); const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [evaluating,setEvaluating]=useState(false);
  const [showProductImport,setShowProductImport]=useState(false);const [productImporting,setProductImporting]=useState(false);
  const [productName,setProductName]=useState('');const [productOwner,setProductOwner]=useState('');const [productReuse,setProductReuse]=useState('');const [productSource,setProductSource]=useState('');const productFile=useRef<HTMLInputElement>(null);
  const {tab,layer,mode,setMode,navigate,chooseGroup,chooseLayer:selectLayer}=useEditorNavigation();
  const productWorkspace=tab==='product'||tab==='material';
  const animatorVisible=tab==='renders'&&mode==='video'&&layer==='Animation';
  const stillFilm=tab==='renders'&&mode==='still';
  const showComparison=!!scene?.comparison&&!productWorkspace&&!animatorVisible;
  const materialEditorVisible=!!scene&&tab==='material'&&layer==='Materials';
  const filmGuidesVisible=tab==='renders'&&!showComparison;
  const [filmGuide,setFilmGuide]=useState<FilmGuideProjection|null>(null);
  useEffect(()=>{if(stillFilm)setPlaying(false)},[stillFilm]);
  const [materialEditorHost,setMaterialEditorHost]=useState<HTMLElement|null>(null);
  const [materialPreview,setMaterialPreview]=useState<MaterialPreview|null>(null);
  const [materialPreviewError,setMaterialPreviewError]=useState('');
  const [positionSpace,setPositionSpace]=useState<'world'|'local'>('local');
  const [transformMode,setTransformMode]=useState<TransformMode|null>(null);
  const [transformDraft,setTransformDraft]=useState<Scene|null>(null);
  const [transformError,setTransformError]=useState('');
  const transformModeRef=useRef<TransformMode|null>(null);
  const transformSource=useRef<Scene|null>(null);
  const transformCommitPending=useRef(false);
  const transformRequest=useRef(0);
  const transformTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const transformAbort=useRef<AbortController|null>(null);
  const transformQueued=useRef<Scene|null>(null);
  const samplesRef=useRef(samples);samplesRef.current=samples;

  const [uvLayout,setUvLayout]=useState<UvLayout|null>(null);
  const [selectedDecalId,setSelectedDecalId]=useState<string|null>(null);
  const [parts,setParts]=useState<ViewportPart[]>([]);const [focused,setFocused]=useState(true);const [inspecting,setInspecting]=useState(false);const [hiddenParts,setHiddenParts]=useState<string[]>([]);
  const [menu,setMenu]=useState<string|null>(null);const menuHost=useRef<HTMLDivElement>(null);
  const chooseLayer=(name:string)=>{selectLayer(name);setMenu(null)};
  useEffect(()=>{setMenu(null)},[tab,layer]);
  const choosePart=(id:string)=>{setSelected(id);setFocused(true)};
  const [showTimeline,setShowTimeline]=useState<boolean|null>(null);
   const [showImport,setShowImport]=useState(false);const [importing,setImporting]=useState(false);
  const [imageUrl,setImageUrl]=useState('');const [preset,setPreset]=useState('botanical-studio');const [creditLimit,setCreditLimit]=useState(6000);const [remoteRuns,setRemoteRuns]=useState<any[]>([]);
  const host=useRef<HTMLDivElement>(null);const hostB=useRef<HTMLDivElement>(null);const stageHost=useRef<HTMLDivElement>(null); const viewport=useRef<ReturnType<typeof createViewport>|null>(null);const viewportB=useRef<ReturnType<typeof createViewport>|null>(null); const newest=useRef(0); const sceneRef=useRef(scene);sceneRef.current=scene;
  const evaluatedScene=useRef<Scene|null>(null);const frameRef=useRef(frame);frameRef.current=frame;const pickingRef=useRef(picking);pickingRef.current=picking;
  // A material draft belongs to this editor view, never to the scene or undo history.
  const materialPreviewScope=materialEditorVisible?`${project?.id ?? ''}:${scene.sceneId}`:null;
  const currentPreviewScope=useRef(materialPreviewScope);currentPreviewScope.current=materialPreviewScope;
  const previewOwner=useRef<string|null>(null);
  const materialPreviewRef=useRef<MaterialPreview|null>(null);
  const previewRequest=useRef(0);const previewClearPending=useRef(false);
  const sendMaterialPreview=useCallback((preview:MaterialPreview|null,scope:string|null)=>{
    const request=++previewRequest.current;
    return Promise.all([
      viewport.current?.setMaterialPreview(preview),
      viewportB.current?.setMaterialPreview(sceneRef.current?.comparison?preview:null),
    ]).then(()=>{},(reason:unknown)=>{
      if(request!==previewRequest.current || scope!==currentPreviewScope.current)return;
      if(reason instanceof Error && reason.name==='AbortError')return;
      setMaterialPreviewError(reason instanceof Error?reason.message:'The material preview could not load.');
    });
  },[]);
  const clearMaterialPreview=useCallback(()=>{
    previewOwner.current=null;materialPreviewRef.current=null;previewClearPending.current=false;
    setMaterialPreview(null);setMaterialPreviewError('');
    void sendMaterialPreview(null,currentPreviewScope.current);
  },[sendMaterialPreview]);
  const previewMaterial=useCallback((preview:MaterialPreview|null)=>{
    // Old material editors may finish an effect after a campaign or layer changes.
    if(!materialPreviewScope || materialPreviewScope!==currentPreviewScope.current)return;
    previewOwner.current=materialPreviewScope;materialPreviewRef.current=preview;
    setMaterialPreview(preview);setMaterialPreviewError('');
    if(!preview && sceneRef.current!==evaluatedScene.current){
      // Save commits immediately, but the renderer receives that scene after evaluation.
      // Keep the matching preview visible until its committed replacement is ready.
      previewClearPending.current=true;++previewRequest.current;return;
    }
    previewClearPending.current=false;
    void sendMaterialPreview(preview,materialPreviewScope);
  },[materialPreviewScope,sendMaterialPreview]);
  const flushMaterialPreviewClear=useCallback(()=>{
    if(!previewClearPending.current || materialPreviewRef.current)return;
    previewClearPending.current=false;
    void sendMaterialPreview(null,currentPreviewScope.current);
  },[sendMaterialPreview]);
  useEffect(()=>{
    if(previewOwner.current!==materialPreviewScope)clearMaterialPreview();
  },[materialPreviewScope,clearMaterialPreview]);

  const previewTransform=useCallback((draft:Scene|null)=>{
    setTransformDraft(draft);setTransformError('');
    transformQueued.current=draft;
    if(!draft){
      ++transformRequest.current;
      if(transformTimer.current)clearTimeout(transformTimer.current);
      transformTimer.current=null;
      transformAbort.current?.abort();transformAbort.current=null;
      if(!transformCommitPending.current && evaluatedScene.current===sceneRef.current){
        const sample=samplesRef.current[frameRef.current-1];
        if(sample)void Promise.all([viewport.current?.setSample(sample),sceneRef.current?.comparison?viewportB.current?.setSample(sample):undefined]).catch(reason=>setTransformError(reason.message));
      }
      return;
    }
    // One evaluation in flight; replace the queued draft while the pointer moves.
    // Unlike a debounce, this keeps rendering throughout a continuous gesture.
    if(transformTimer.current || transformAbort.current)return;
    const request=transformRequest.current,source=transformSource.current;
    const flush=async()=>{
      transformTimer.current=null;
      const queued=transformQueued.current;transformQueued.current=null;
      if(!queued || request!==transformRequest.current || sceneRef.current!==source)return;
      const abort=new AbortController();transformAbort.current=abort;
      try{
        const result=await api('/api/evaluate','POST',{scene:queued,frame:frameRef.current},abort.signal);
        if(request!==transformRequest.current||sceneRef.current!==source||abort.signal.aborted)return;
        await Promise.all([viewport.current?.setSample(result.sample),source?.comparison?viewportB.current?.setSample(result.sample):undefined]);
      }catch(reason:any){
        if(request===transformRequest.current&&!abort.signal.aborted)setTransformError(reason.message);
      }finally{
        if(transformAbort.current===abort)transformAbort.current=null;
        if(request===transformRequest.current&&transformQueued.current)transformTimer.current=setTimeout(flush,16);
      }
    };
    transformTimer.current=setTimeout(flush,16);
  },[]);
  const updateTransformMode=useCallback((mode:TransformMode|null)=>{
    transformModeRef.current=mode;setTransformMode(mode);
  },[]);
  useEffect(()=>()=>{++transformRequest.current;transformAbort.current?.abort();if(transformTimer.current)clearTimeout(transformTimer.current);},[]);

  const pickHandler=useRef<(side:Side,point:any)=>void>(()=>{});
  const [worldName,setWorldName]=useState('Campaign room');const [owner,setOwner]=useState('');const [reuse,setReuse]=useState('');const [sourceUp,setSourceUp]=useState('Y');
  const file=useRef<HTMLInputElement>(null);const total=scene?.shots.at(-1)?.endFrame??360;const fps=scene?.render.fps??24;
  const shot=scene?.shots.find((s:any)=>frame>=s.startFrame&&frame<=s.endFrame)??scene?.shots[0];
  const dirty=!!scene&&!equalJson(scene,project?.scene);
  const valid=!!scene&&!!samples.length&&!evaluating&&!validationError&&evaluatedScene.current===scene;
  const calibrationRef=useRef(calibrationDrafts);calibrationRef.current=calibrationDrafts;
  const calibrationKey=JSON.stringify(scene?.comparison?.calibration??{});
  const calibrationWorldKey=JSON.stringify([scene?.environment,scene?.comparison?.alternative].map(environment=>[environment?.asset?.sha256,environment?.asset?.sourceUp,environment?.revisionId]));
  useEffect(()=>{const saved=JSON.parse(calibrationKey);const draft=(side:Side):CalibrationDraft=>({floor:saved[side]?.sourceFloorPoint,points:saved[side]?.measurement?.sourcePoints??[],distance:saved[side]?.measurement?.realDistanceM?.toString()??'',yaw:''});setCalibrationDrafts({a:draft('a'),b:draft('b')});setPicking(null)},[calibrationKey,calibrationWorldKey,project?.id]);
  const change=(edit:(s:Scene)=>void)=>{setPlaying(false);setPicking(null);setNotice('');setError('');setHistory(previous=>{if(!previous.present)return previous;const next=clone(previous.present);edit(next);return commitHistory(previous,next)})};
  const loadProject=(p:Project)=>{clearMaterialPreview();viewport.current?.resetFraming();viewportB.current?.resetFraming();try{localStorage.setItem('gesso.project',p.id)}catch{}setProject(p);setHistory(createHistory(p.scene));setFrame(1);setPlaying(false);setPicking(null);setError('');setValidationError('');setParts([]);setUvLayout(null);setSelectedDecalId(null);setSelected(p.scene.product.label?.componentId??p.scene.product.components[0]?.id??null);setFocused(true);setInspecting(false);setHiddenParts([]);setNotice('Project opened')};
  useEffect(()=>{api('/api/bootstrap').then(async b=>{let remembered:string|null=null;try{remembered=localStorage.getItem('gesso.project')}catch{}let opened=b.project;if(remembered&&remembered!==opened.id&&b.projects.some((p:any)=>p.id===remembered)){try{opened=await api(`/api/projects/${remembered}`)}catch{}}loadProject(opened);setProjects(b.projects);setWorlds(b.worlds);setCaps(b.capabilities);setJobs(b.jobs)}).catch(e=>setError(e.message))},[]);
  useEffect(()=>{const hostElement=host.current;const secondHost=hostB.current;if(!hostElement||!secondHost)return;const view=createViewport(hostElement,{studioMode:true,onFilmGuide:setFilmGuide,onInteract:()=>{setPlaying(false);setInspecting(true)},onParts:setParts,onError:setValidationError,onWorldPoint:point=>pickHandler.current('a',point)});const second=createViewport(secondHost,{studioMode:true,onInteract:()=>{setPlaying(false);setInspecting(true)},onError:message=>{if(sceneRef.current?.comparison)setValidationError(message)},onWorldPoint:point=>pickHandler.current('b',point)});viewport.current=view;viewportB.current=second;
    return()=>{++previewRequest.current;currentPreviewScope.current=null;view.dispose();second.dispose();viewport.current=null;viewportB.current=null}},[]);
  useEffect(()=>{if(!scene)return;const request=++newest.current;setEvaluating(true);const timer=setTimeout(()=>{
    api('/api/evaluate','POST',{scene}).then(async result=>{if(request!==newest.current)return;if(scene.comparison&&(!result.comparison?.a||!result.comparison?.b))throw new Error('Both environment scenes are required for comparison preview.');const sampled=result.frames[Math.min(frameRef.current-1,result.frames.length-1)];
      if(!result.comparison)viewportB.current?.clearScene();
      await Promise.all([viewport.current?.setScene(result.comparison?.a??result.scene,sampled),result.comparison?viewportB.current?.setScene(result.comparison.b,sampled):Promise.resolve()]);
      if(request!==newest.current)return;const currentFrame=Math.min(frameRef.current,result.frames.length);const currentSample=result.frames[currentFrame-1];
      await Promise.all([viewport.current?.setSample(currentSample),result.comparison?viewportB.current?.setSample(currentSample):Promise.resolve()]);
      if(request===newest.current){evaluatedScene.current=scene;transformCommitPending.current=false;flushMaterialPreviewClear();setSamples(result.frames);setDigest(result.digest);setComparisonInfo(result.comparison??null);setFrame(currentFrame);setValidationError('');setEvaluating(false)}
    }).catch(e=>{if(request===newest.current){setValidationError(e.message);setEvaluating(false)}})
  },180);return()=>clearTimeout(timer)},[scene]);
  useEffect(()=>{viewport.current?.setFilmGuides(filmGuidesVisible)},[filmGuidesVisible]);
  useEffect(()=>{const sample=samples[frame-1];if(sample&&evaluatedScene.current===scene)void Promise.all([viewport.current?.setSample(sample),scene?.comparison?viewportB.current?.setSample(sample):Promise.resolve()]).catch(e=>setValidationError(e.message))},[samples,frame,scene]);
  useEffect(()=>{setUvLayout(selected?viewport.current?.getUvLayout(selected)??null:null)},[parts,selected]);
  useEffect(()=>{viewport.current?.setSelected(selected);viewportB.current?.setSelected(selected)},[selected]);
  useEffect(()=>{const part=tab==='material'&&layer==='Decals'?selected:null;viewport.current?.setUvProbePart(part);viewportB.current?.setUvProbePart(part)},[tab,layer,selected]);
  const hoverUv=useCallback((uv:[number,number]|null)=>{viewport.current?.setUvProbe(uv);viewportB.current?.setUvProbe(uv)},[]);
  const decalInteractionSurface=useCallback((element:HTMLDivElement|null)=>{viewport.current?.setInteractionSurface(element)},[]);
  useEffect(()=>{if(!scene)return;const all=parts.length?parts:sceneParts(scene);const {parents}=resolveHierarchy(scene,all);const members=all.filter(part=>{let id:string|null=part.id;const visited=new Set<string>();while(id&&!visited.has(id)){if(id===selected)return true;visited.add(id);id=parents[id]??null}return false}).map(part=>part.id);viewport.current?.setFocusParts(members);viewportB.current?.setFocusParts(members);const hidden=all.filter(part=>{let id:string|null=part.id;const visited=new Set<string>();while(id&&!visited.has(id)){if(hiddenParts.includes(id))return true;visited.add(id);id=parents[id]??null}return false}).map(part=>part.id);viewport.current?.setHiddenParts(hidden);viewportB.current?.setHiddenParts(hidden)},[parts,selected,scene,hiddenParts]);
  useEffect(()=>{const enabled=!showComparison&&!transformMode;viewport.current?.setInspectionEnabled(enabled);viewportB.current?.setInspectionEnabled(enabled);if(showComparison){viewport.current?.resetFraming();viewportB.current?.resetFraming();setInspecting(false)}},[showComparison,transformMode]);
  useEffect(()=>{viewport.current?.setProductPreview(productWorkspace);viewportB.current?.setProductPreview(productWorkspace);setPicking(null)},[productWorkspace]);
  useEffect(()=>{const enabled=focused&&(tab==='product'||tab==='material'&&layer==='Decals'||animatorVisible);viewport.current?.setPartFocus(enabled);viewportB.current?.setPartFocus(enabled)},[focused,tab,layer,animatorVisible]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer)},[notice]);
  useEffect(()=>{const outside=(e:PointerEvent)=>{if(!menuHost.current?.contains(e.target as Node))setMenu(null)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[]);
  useEffect(()=>{const refresh=()=>{void api('/api/jobs').then(setJobs).catch(()=>{});void api('/api/comparison-renders').then(setPairJobs).catch(()=>{})};refresh();const interval=setInterval(refresh,1800);return()=>clearInterval(interval)},[]);
  useEffect(()=>{viewport.current?.setWorldPickEnabled(picking?.side==='a');viewportB.current?.setWorldPickEnabled(picking?.side==='b')},[picking]);
  useEffect(()=>{const hidden=()=>{if(document.hidden)setPlaying(false)};document.addEventListener('visibilitychange',hidden);
    const observer=new IntersectionObserver(entries=>{if(!entries[0]?.isIntersecting)setPlaying(false)});if(stageHost.current)observer.observe(stageHost.current);
    return()=>{document.removeEventListener('visibilitychange',hidden);observer.disconnect()}},[]);
  useEffect(()=>{if(!playing)return;setPicking(null);let raf=0;let start=performance.now();const first=frame;const tick=(time:number)=>{const next=first+Math.floor((time-start)/1000*fps);if(next>total){setPlaying(false);setFrame(total);return}setFrame(next);raf=requestAnimationFrame(tick)};raf=requestAnimationFrame(tick);return()=>cancelAnimationFrame(raf)},[playing,fps,total]);
  useEffect(()=>{const key=(e:KeyboardEvent)=>{const target=e.target as HTMLElement;if(e.defaultPrevented||transformModeRef.current)return;if(e.isComposing||['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable)return;
    const destination=shortcutDestination(e,tab,mode);if(destination){e.preventDefault();if(target?.closest('.timeline')){const label=destination.group?groups.find(group=>group.id===destination.group)?.label:destination.layer;menuHost.current?.querySelector<HTMLButtonElement>(`.gesso-navrow button[aria-label="${label}"]`)?.focus()}if(destination.group)chooseGroup(destination.group);if(destination.layer)selectLayer(destination.layer);setMenu(null);return}
    if(!e.altKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyF'){e.preventDefault();setPlaying(false);if(e.shiftKey){setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming()}else{setInspecting(true);viewport.current?.frameSelection();viewportB.current?.frameSelection()}return}
    if(e.key==='Escape'){setMenu(null);setPicking(null);return}
    if((e.metaKey||e.ctrlKey)&&e.code==='KeyS'){e.preventDefault();if(dirty&&!busy&&!evaluating)void save();return}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();setHistory(h=>e.shiftKey?redoHistory(h):undoHistory(h));setPlaying(false);setPicking(null)}
    else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='y'){e.preventDefault();setHistory(redoHistory);setPlaying(false);setPicking(null)}
    else if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&e.code==='Space'){e.preventDefault();if(valid&&!stillFilm&&!e.repeat){if(frameRef.current===total)setFrame(1);setPlaying(p=>!p)}}
    else if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();setPlaying(false);setFrame(f=>Math.max(1,Math.min(total,f+(e.key==='ArrowRight'?1:-1))))}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[total,valid,tab,mode,stillFilm,dirty,busy,evaluating,scene,project,chooseGroup,selectLayer]);
  const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  const openCampaign=(id:string)=>{
    if(dirty||busy||id===project?.id)return;
    const current=sceneRef.current;
    void perform(async()=>{
      const opened=await api(`/api/projects/${id}`);
      if(sceneRef.current!==current)throw new Error('The current campaign changed while opening another. Save the revision before switching.');
      loadProject(opened);navigate('world','Environment');setShowTimeline(null);setMenu(null);
    });
  };
  const commitComparison=(next:Scene)=>{setPlaying(false);setPicking(null);setError('');setNotice('');setHistory(previous=>commitHistory(previous,next))};
  const editComparison=(edit:(current:Scene)=>Scene)=>{try{if(sceneRef.current)commitComparison(edit(sceneRef.current))}catch(e:any){setError(e.message)}};
  const startComparison=()=>{editComparison(current=>enableComparison(current,worlds));setComparisonMode('split')};
  const comparisonWorld=(side:Side,id:string)=>{const world=worlds.find(item=>item.id===id);if(world)editComparison(current=>setComparisonWorld(current,side,world))};
  const comparisonTransform=(side:Side,field:'scaleToMeters'|'translationM',value:number,axis?:number)=>editComparison(current=>updateWorldTransform(current,side,asset=>{if(field==='scaleToMeters')asset.scaleToMeters=value;else asset.translationM[axis!]=value}));
  const changeComparisonMode=(mode:ComparisonMode)=>{setComparisonMode(mode);if(mode!=='split'&&pickingRef.current&&pickingRef.current.side!==mode)setPicking(null)};
  const draftCalibration=(side:Side,patch:Partial<CalibrationDraft>)=>setCalibrationDrafts(previous=>({...previous,[side]:{...previous[side],...patch}}));
  const startPick=(side:Side,kind:'floor'|'measurement')=>{setPlaying(false);setComparisonMode(mode=>mode==='split'?'split':side);if(kind==='measurement')draftCalibration(side,{points:[]});setPicking({side,kind})};
  pickHandler.current=(side,point)=>{const request=pickingRef.current;if(!request||request.side!==side||!Array.isArray(point.sourcePoint)||point.sourcePoint.length!==3||!point.sourcePoint.every(Number.isFinite))return;const sourcePoint=point.sourcePoint as [number,number,number];if(request.kind==='floor'){draftCalibration(side,{floor:sourcePoint});setPicking(null)}else{const points=[...calibrationRef.current[side].points,sourcePoint].slice(0,2);draftCalibration(side,{points});if(points.length===2)setPicking(null)}};
  const applyCalibration=(side:Side)=>perform(async()=>{const current=sceneRef.current;if(!current?.comparison||!valid)throw new Error('Wait for both environment previews to load.');const draft=calibrationDrafts[side];const calibration:any={};if(draft.floor)calibration.sourceFloorPoint=draft.floor;if(draft.points.length){if(draft.points.length!==2||!Number.isFinite(Number(draft.distance))||Number(draft.distance)<=0)throw new Error('Pick two measurement points and enter their positive distance in meters.');calibration.measurement={sourcePoints:draft.points,realDistanceM:Number(draft.distance)}}if(draft.yaw!==''){if(!Number.isFinite(Number(draft.yaw)))throw new Error('Yaw must be a finite number.');calibration.yawDeltaDegrees=Number(draft.yaw)}if(!Object.keys(calibration).length)throw new Error('Choose a floor point, a known distance, or an additional yaw.');const result=await api('/api/comparison/calibrate','POST',{scene:current,side,calibration});if(sceneRef.current!==current)throw new Error('The scene changed while placement was being calculated. Apply it again to the current scene.');commitComparison(result.scene);setNotice(`Environment ${side.toUpperCase()} placement applied. Save a revision to keep it.`)});
  const reviewComparison=()=>perform(async()=>{const current=sceneRef.current;if(!current?.comparison||!valid)throw new Error('Wait for both environment previews to load.');const result=await api('/api/comparison/review','POST',{scene:current});if(sceneRef.current!==current)throw new Error('The scene changed during review. Review the current placement again.');commitComparison(result.scene);setNotice('Placement review recorded. Save this revision to preserve it.')});
  const save=()=>perform(async()=>{if(transformModeRef.current)throw new Error('Apply or cancel the transform before saving.');if(!project||!scene)return;const result=await api(`/api/projects/${project.id}`,'PUT',{scene,expectedRevisionId:project.revisionId});setProject(result);setProjects(await api('/api/projects'));setNotice('Revision saved')});
  const approve=()=>perform(async()=>{if(!project||dirty)throw new Error('Save this revision before approving it.');const result=await api(`/api/projects/${project.id}/approve`,'POST',{expectedRevisionId:project.revisionId});setProject(result);setNotice('Approved revision preserved')});
  const restore=()=>perform(async()=>{if(!project?.approvedRevisionId)return;const old=await api(`/api/projects/${project.id}/revisions/${project.approvedRevisionId}`);setHistory(h=>commitHistory(h,old.scene));setNotice('Approved scene restored as an editable draft')});
  const render=(kind:string)=>perform(async()=>{if(transformModeRef.current)throw new Error('Apply or cancel the transform before exporting.');if(materialPreviewRef.current)throw new Error('Save or discard the material preview before exporting.');if(!valid)throw new Error('Wait for the current scene and both comparison previews to load.');setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming();const paired=!!scene.comparison;const job=await api(paired?'/api/comparison-renders':'/api/renders','POST',{scene,kind,frame,width:scene.render.width,height:scene.render.height,samples:scene.render.samples});if(paired)setPairJobs(j=>[job,...j.filter(x=>x.id!==job.id)]);else setJobs(j=>[job,...j.filter(x=>x.id!==job.id)]);navigate('renders','Output');setNotice(paired?`Matching ${kind==='still'?'stills':'reels'} queued · ${job.alignmentStatus==='reviewed'?'placement reviewed':'draft placement'}`:kind==='still'?'Cycles still queued':'Draft reel queued')});
  const replaceWorld=(id:string)=>change(s=>{if(id==='authored'){const e=clone(s.environment);delete e.asset;delete e.fixture;e.kind='authored';e.revisionId='neutral-studio-v1';e.displayName='Authored studio';e.provenance={source:'Original authored studio',owner:'3d-product-suite',reuseBasis:'Original project geometry',allowedExternalDestinations:[]};s.environment=e;return}const world=worlds.find(w=>w.id===id);if(!world)return;const e=clone(world.environment);e.plinth=clone(s.environment.plinth);if(s.environment.props)e.props=clone(s.environment.props);s.environment=e});
  const importFile=async()=>{const chosen=file.current?.files?.[0];if(!chosen)return;setImporting(true);setError('');try{const q=new URLSearchParams({name:worldName,owner,reuseBasis:reuse,sourceUp});const result=await fetch(`/api/worlds/import?${q}`,{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':chosen.name},body:chosen});const data=await result.json();if(!result.ok)throw new Error(data.error);setWorlds(await api('/api/worlds'));setShowImport(false);setNotice(`${data.name} imported; review its alignment before rendering`)}catch(e:any){setError(e.message)}finally{setImporting(false)}};
  const importProduct=async()=>{const chosen=productFile.current?.files?.[0];if(!chosen)return;setProductImporting(true);setError('');try{const q=new URLSearchParams({name:productName,owner:productOwner,reuseBasis:productReuse,source:productSource});const result=await fetch(`/api/products/import?${q}`,{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':chosen.name},body:chosen});const data=await result.json();if(!result.ok)throw new Error(data.error);loadProject(data);setProjects(await api('/api/projects'));setShowProductImport(false);setNotice('Product imported with its original geometry and materials.')}catch(e:any){setError(e.message)}finally{setProductImporting(false)}};
  const generate=()=>perform(async()=>{const result=await api('/api/github-worlds/generate','POST',{imageUrl,preset,budgetCredits:creditLimit});setNotice(`World comparison submitted to GitHub Actions. Experiment ${result.id.slice(0,8)}. Both final alternatives will be meshes.`);setRemoteRuns(await api('/api/github-worlds/runs'))});
  const refreshRuns=()=>perform(async()=>{setRemoteRuns(await api('/api/github-worlds/runs'))});
  const importRun=(id:number)=>perform(async()=>{await api(`/api/github-worlds/runs/${id}/import`,'POST');setWorlds(await api('/api/worlds'));setNotice('World Labs mesh, Gaussian-derived mesh, and native splat imported. Review alignment before approval.')});
  const labels=scene?comparisonLabels(scene):{a:'Environment A',b:'Environment B'};
  const groupName=groups.find(item=>item.id===tab)!.label;
  const toggleVisibility=(id:string)=>setHiddenParts(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const framePart=()=>{setPlaying(false);setInspecting(true);viewport.current?.frameSelection();viewportB.current?.frameSelection()};
  const frameProp=(id:string)=>{setPlaying(false);setInspecting(true);viewport.current?.frameWorldObject(id);viewportB.current?.frameWorldObject(id)};
  const resetView=()=>{setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming()};
  const undo=()=>{setPlaying(false);setPicking(null);setHistory(undoHistory)};
  const redo=()=>{setPlaying(false);setPicking(null);setHistory(redoHistory)};
  const timelineVisible=animatorVisible||(!stillFilm&&!(tab==='material'&&layer==='Decals')&&(showTimeline??tab==='renders'));
  const previewFrame=(next:number)=>{setPlaying(false);setFrame(next)};
  const filmCamera=useFilmCamera({scene,samples:valid?samples:[],frame,mode,active:filmGuidesVisible&&layer==='Framing',enabled:valid&&!playing&&!busy,guide:filmGuide,viewport,onChange:change,onFrame:previewFrame,onResetView:resetView});
  const activeDecal=decalForPart(scene,selected,selectedDecalId);
  const selectedPart=parts.find(part=>part.id===selected)??sceneParts(scene).find(part=>part.id===selected);
  const transformPart=selectedPart??(parts.length?parts:sceneParts(scene))[0];
  const transformTarget:TransformTarget|null=positionSpace==='world'?{kind:'product'}:
    transformPart && transformPart.id===transformPart.componentId ? {kind:'part',componentId:transformPart.componentId}:null;
  const startTransform=()=>{
    transformSource.current=sceneRef.current;transformCommitPending.current=false;
    setPlaying(false);setPicking(null);setNotice('');setTransformError('');
    viewport.current?.freezeSelectionFraming();viewportB.current?.freezeSelectionFraming();
    navigate('renders','Animation');
  };
  const commitTransform=(edit:(next:Scene)=>void)=>{
    if(transformSource.current!==sceneRef.current)return;
    transformCommitPending.current=true;change(edit);
  };
  const addDecal=()=>{
    if(!scene||!selected||!selectedPart||!uvLayout||uvLayout.missingUv||!uvLayout.triangleCount)return;
    const decal=newDecal(scene,selected,selectedPart.componentId,uvLayout);
    change(next=>{next.product.decals=[...(next.product.decals??[]),decal]});setSelectedDecalId(decal.id);
  };
  const placeDecal=(centerUv:[number,number])=>{if(activeDecal)change(next=>{
    const target=next.product.decals?.find((item:ProductDecal)=>item.id===activeDecal.id);if(target)target.centerUv=centerUv;
  })};
  const productPanel=scene?<ProductPanel workspace={tab==='renders'?'animation':tab==='material'?'material':'product'} key={`${project?.id ?? ''}:${scene.sceneId}`} onPreview={previewMaterial} editorHost={materialEditorVisible?materialEditorHost:null} positionSpace={positionSpace} onPositionSpace={setPositionSpace} transformMode={transformMode} scene={transformDraft??scene} partId={selected} parts={parts} layer={layer as ProductLayer} onSelect={choosePart} onChange={change} onLayer={name=>chooseLayer(name)} focused={focused} onToggleFocus={()=>setFocused(value=>!value)} onFrame={framePart} hiddenParts={hiddenParts} onToggleVisibility={toggleVisibility} onImport={()=>setShowProductImport(value=>!value)} frame={frame} onPreviewFrame={previewFrame} decal={activeDecal} uvLayout={uvLayout} onAddDecal={addDecal} onSelectDecal={setSelectedDecalId}/>:null;
  const railWidth=340;
  return <div className="studio gesso-studio" style={{'--rail-width':`${railWidth}px`} as React.CSSProperties}>
    <header className="gesso-topbar" ref={menuHost}>
      <div className="gesso-appbar">
        <a className="gesso-wordmark" href="/" aria-label="gesso studio">gesso<span>studio</span></a>
        <nav className="gesso-appmenus" aria-label="Application">
          {['File','Edit','View'].map(name=><button key={name} aria-expanded={menu===name} onClick={()=>setMenu(menu===name?null:name)}>{name}</button>)}
          {['Plugins','Widgets'].map(name=><button key={name} className="gesso-reserved-menu" disabled title={`${name} are not available in this prototype`}>{name}</button>)}
        </nav>
        <div className="gesso-header-actions">
          <button aria-label="Undo" title="Undo (⌘/Ctrl Z)" disabled={!canUndo(history)} onClick={undo}>Undo</button>
          <button aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" disabled={!canRedo(history)} onClick={redo}>Redo</button>
          <button aria-expanded={menu==='History'} onClick={()=>setMenu(menu==='History'?null:'History')}>History</button>
          <>{!dirty ? <span className="gesso-save-status" role="status" title={project?'Saved locally':'Opening campaign'}><UiIcon name={busy||!project?'loader':'check'}/>{busy?'Working…':project?'Saved':'Opening…'}</span> : <button className="gesso-save" disabled={!!transformMode||busy||!project||evaluating} onClick={save} title={materialPreview?'Save the material preset first to include its preview in this revision':'Save revision (⌘/Ctrl S)'}>{busy?'Working…':'Save'}</button>}</>
          <img className="gesso-avatar" src={avatar} alt=""/>
        </div>
      </div>
      <EditorNavigation group={tab} onGroup={group=>{chooseGroup(group);setMenu(null)}} mode={mode} onMode={next=>{setPlaying(false);setMode(next);setMenu(null)}}/>
      {menu&&<div className={`gesso-menu ${menu==='History'?'gesso-menu-right':''}`} aria-label={`${menu} options`}>
        {menu==='File'&&<><div className="gesso-menu-heading">{project?.name??'Opening project…'}</div><button disabled={!!transformMode||!dirty||busy||evaluating} onClick={()=>{void save();setMenu(null)}}>Save revision <kbd>⌘ S</kbd></button><button onClick={()=>{chooseGroup('product');setShowProductImport(true);setMenu(null)}}>Import product GLB</button><button disabled={!!materialPreview||!valid||busy||!caps.blenderAvailable||!caps.ffmpegAvailable} onClick={()=>{void render('reel');setMenu(null)}}>Export reel</button>    <div className="project-switch"><Field label="Campaign"><select aria-label="Campaign" title={dirty?'Save this revision before switching campaigns':undefined} disabled={busy||dirty} value={project?.id??''} onChange={e=>openCampaign(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>{dirty&&<p className="gesso-note">Save this revision to switch campaigns.</p>}<button className="text-button" disabled={busy} onClick={()=>perform(async()=>{const p=await api('/api/projects','POST',{name:`Campaign ${projects.length+1}`,scene});loadProject(p);setProjects(await api('/api/projects'))})}>＋ Duplicate as new campaign</button></div>
</>}
        {menu==='Edit'&&<><button disabled={!canUndo(history)} onClick={undo}>Undo <kbd>⌘ Z</kbd></button><button disabled={!canRedo(history)} onClick={redo}>Redo <kbd>⇧ ⌘ Z</kbd></button></>}
        {menu==='View'&&<>{!stillFilm&&!animatorVisible&&!(tab==='material'&&layer==='Decals')&&<button onClick={()=>{setShowTimeline(!timelineVisible);setMenu(null)}}>{timelineVisible?'Hide':'Show'} timeline</button>}{(tab==='product'||tab==='material'&&layer==='Decals'||animatorVisible)&&<button onClick={()=>{setFocused(v=>!v);setMenu(null)}}>{focused?'Show assembly':'Focus selected part'}</button>}<button onClick={()=>{framePart();setMenu(null)}}>Frame selected part <kbd>F</kbd></button><button onClick={()=>{resetView();setMenu(null)}}>Return to shot camera <kbd>⇧ F</kbd></button><p className="gesso-note">Option / Alt 1–4 selects a step.<br/>Option / Alt {stillFilm?'5–6':'5–8'} opens its controls.<br/>Drag to orbit. Shift-drag to pan.<br/>Scroll to zoom.</p></>}
        {menu==='History'&&<><div className="gesso-menu-heading">{project?.name}</div><p className="gesso-note">{history.past.length} undo steps · {history.future.length} redo steps</p><button disabled={busy||dirty} onClick={approve}>Approve saved revision</button><button disabled={!project?.approvedRevisionId||busy} onClick={restore}>Restore approved scene</button><p className="gesso-note">{dirty?'Unsaved changes':'Current revision saved locally'}</p></>}
      </div>}
    </header>
    <div className={`gesso-workspace ${materialEditorVisible?'with-material-editor':''}`}>
      <aside className="gesso-sidebar" aria-label={`${groupName} controls`}>
        {tab!=='product'&&<h1 className="gesso-panel-title">{groupName}</h1>}
        <div className={`gesso-sidebar-content gesso-condensed-sidebar ${tab==='product'&&showProductImport?'has-import':''}`}>
          {transformError&&<div className="message error" role="alert">{transformError}</div>}{materialEditorVisible&&materialPreviewError&&<div className="message error" role="alert">Material preview: {materialPreviewError}</div>}{validationError&&<div className="message error" role="alert">{validationError}</div>}{error&&<div className="message error" role="alert">{error}</div>}
          {!scene&&<p className="gesso-note">{error?'The project could not be opened.':'Opening project…'}</p>}
          {scene&&productWorkspace&&productPanel}
          {tab==='product'&&<>{showProductImport&&<div className="import-form control-section"><div className="gesso-section-heading">Import product <button aria-label="Close import" onClick={()=>setShowProductImport(false)}>×</button></div><Field label="Product name"><input value={productName} onChange={e=>setProductName(e.target.value)}/></Field><Field label="Product owner"><input value={productOwner} onChange={e=>setProductOwner(e.target.value)}/></Field><Field label="Source URL or reference"><input value={productSource} onChange={e=>setProductSource(e.target.value)}/></Field><Field label="Usage permission or license"><input value={productReuse} onChange={e=>setProductReuse(e.target.value)}/></Field><p className="small-copy">Use a static, self-contained GLB in meters, centered at its bounding-box origin. CAD needs conversion first.</p><input aria-label="Product GLB file" type="file" accept=".glb" ref={productFile}/><button disabled={!productName||!productOwner||!productReuse||!productSource||productImporting} onClick={importProduct}>{productImporting?'Importing…':'Import product'}</button></div>}</>}
          {scene&&tab==='world'&&<WorldPanel onLayer={chooseLayer} onFrameProp={frameProp} scene={scene} layer={layer as WorldLayer} worlds={worlds} onChange={change} onWorld={replaceWorld} onImport={()=>setShowImport(value=>!value)}>
            {showImport&&<div className="import-form"><Field label="World name"><input value={worldName} onChange={e=>setWorldName(e.target.value)}/></Field><Field label="Asset owner"><input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="Your company or creator"/></Field><Field label="Reuse basis"><input value={reuse} onChange={e=>setReuse(e.target.value)} placeholder="License or permission"/></Field><Field label="Source up axis"><select value={sourceUp} onChange={e=>setSourceUp(e.target.value)}><option>Y</option><option>Z</option></select></Field><input aria-label="World export file" type="file" accept=".glb,.spz,.ply" ref={file}/><button disabled={!owner||!reuse||importing} onClick={importFile}>{importing?'Importing…':'Import GLB / SPZ / PLY'}</button></div>}
            <details className="gesso-disclosure" open={scene.comparison?true:undefined}><summary>Compare environments</summary><ComparisonPanel scene={scene} worlds={worlds} info={comparisonInfo} busy={busy} ready={valid} mode={comparisonMode} drafts={calibrationDrafts} picking={picking} onMode={changeComparisonMode} onEnable={startComparison} onDisable={()=>change(s=>{delete s.comparison})} onWorld={comparisonWorld} onTransform={comparisonTransform} onDraft={draftCalibration} onPick={startPick} onCancelPick={()=>setPicking(null)} onCalibrate={applyCalibration} onReview={reviewComparison}/></details>
            <details className="gesso-disclosure"><summary>Generate environment</summary><section className="control-section"><p className="small-copy">Choose a default above to start immediately. Or generate one world and compare World Labs’ mesh with a mesh reconstructed from its Gaussians.</p><Field label="Generation preset"><select value={preset} onChange={e=>setPreset(e.target.value)}><option value="botanical-studio">Botanical studio</option><option value="warm-gallery">Warm limestone gallery</option><option value="modern-loft">Modern loft</option></select></Field><Field label="Reference image URL (optional)"><input type="url" value={imageUrl} onChange={e=>setImageUrl(e.target.value)} placeholder="https://…/reference.jpg"/></Field><p className="small-copy">Use a public HTTPS image URL, or leave blank to generate from the preset. Private image files can use the local CLI. Your key stays encrypted in GitHub.</p><NumberControl label="API credit limit" value={creditLimit} min={5080} max={6000} step={100} onChange={setCreditLimit}/><p className="small-copy">Standard world + textured mesh: about 5,080 API credits ($4.06). No automatic paid retries.</p><button className="wide" disabled={busy||!caps.githubWorldsAvailable} onClick={generate}>Generate mesh comparison ↗</button><a className="text-link" style={{marginTop:12}} href={caps.githubWorkflowUrl??'https://github.com/kimestelle/3d-product-suite/actions/workflows/worldlabs-pair.yml'} target="_blank" rel="noreferrer">Open GitHub workflow ↗</a><button className="text-button" disabled={busy} onClick={refreshRuns}>Refresh generation runs</button>{remoteRuns.map(run=><article key={run.id} className="job"><div className="job-heading"><b>{run.name}</b><span className="job-state">{run.conclusion??run.status}</span></div><a className="text-link" href={run.url} target="_blank" rel="noreferrer">View generation ↗</a>{run.conclusion==='success'&&<button className="wide" style={{marginTop:10}} disabled={busy} onClick={()=>importRun(run.id)}>Import both meshes</button>}</article>)}</section></details>
          </WorldPanel>}
          {scene&&tab==='renders'&&<FilmPanel scene={scene} mode={mode} cameraEnd={filmCamera.end} onCameraEndChange={filmCamera.onEndChange} viewportControls={filmGuidesVisible} cameraTargetId={filmCamera.targetId} onCameraTargetChange={filmCamera.onTargetChange} layer={layer as 'Framing'|'Animation'|'Sequence'|'Output'} onLayerChange={chooseLayer} animationContent={productPanel} samples={valid?samples:[]} onResetView={resetView} frame={frame} onChange={change} onFrame={previewFrame} onRender={kind=>void render(kind)} renderDisabled={!!transformMode||!!materialPreview||!valid||!caps.blenderAvailable} renderReelDisabled={!caps.ffmpegAvailable} renderBusy={busy} renderJobs={<section className="gesso-section"><div className="gesso-section-heading">Local jobs <span>{jobs.length+pairJobs.length}</span></div>{!caps.blenderAvailable&&<p className="gesso-error">{caps.blenderIssue??'Blender 4.3.2 is required to render.'}</p>}{mode==='video'&&!caps.ffmpegAvailable&&<p className="gesso-error">{caps.ffmpegIssue??'FFmpeg 7.1.5 is required to export video.'}</p>}{jobs.length===0&&pairJobs.length===0&&<p className="empty-state">Rendered stills and reels appear here.</p>}<ComparisonJobList jobs={pairJobs} digest={digest} busy={busy} onControl={(id,action)=>perform(async()=>{await api(`/api/comparison-renders/${id}/${action}`,'POST');setPairJobs(await api('/api/comparison-renders'))})}/>{jobs.map(job=><article className="job" key={job.id}><div className="job-heading"><b>{job.kind==='still'?'Cycles still':'Draft reel'}</b><span className={`job-state ${job.state}`}>{job.state}</span></div><p>{job.frame?`Frame ${job.frame} · `:''}{job.completedFrames}/{job.totalFrames} frames{job.stage==='capturing'?' · Capturing Gaussians':''}</p>{job.sourceDigest!==digest&&<small className="stale">Earlier scene revision</small>}{job.error&&<p className="job-error">{job.error}</p>}<div className="job-links">{job.artifacts.map(a=><a key={a.name} href={a.url} target="_blank" rel="noreferrer">{a.name==='still.png'?'View still ↗':a.name==='film.mp4'?'Watch reel ↗':a.name==='scene.blend'?'Scene ↓':a.name}</a>)}</div>{['queued','running'].includes(job.state)&&<button onClick={()=>perform(async()=>{await api(`/api/jobs/${job.id}/cancel`,'POST');setJobs(await api('/api/jobs'))})}>Cancel</button>}{['failed','cancelled','interrupted'].includes(job.state)&&<button onClick={()=>perform(async()=>{await api(`/api/jobs/${job.id}/resume`,'POST');setJobs(await api('/api/jobs'))})}>Resume</button>}</article>)}</section>}/>}

        </div>
        <footer className="gesso-sidebar-footer"><span>{productWorkspace||animatorVisible?`${parts.length||scene?.product.components.length||0} parts · millimeters`:project?.name??'Local workspace'}</span><span title={validationError||'Live preview'}>{evaluating?'Updating…':validationError?'Needs attention':'Live'}</span></footer>
      </aside>
      <main className={`gesso-stage ${timelineVisible?'with-timeline':''} ${animatorVisible?'with-keyframes':''}`} aria-label="Product window">
        {showComparison&&<div className="comparison-toolbar"><div className="segmented" aria-label="Comparison display">{(['a','b','split'] as const).map(mode=><button key={mode} aria-pressed={comparisonMode===mode} onClick={()=>changeComparisonMode(mode)}>{mode==='split'?'Split':mode.toUpperCase()}</button>)}</div><span className="comparison-status">{valid&&comparisonInfo?.alignmentStatus==='reviewed'?'Placement reviewed':'Draft placement'}</span><button onClick={()=>{navigate('world','Environment')}}>Adjust placement</button></div>}
        <div className={`viewport-wrap ${showComparison?'has-comparison':''} ${filmGuidesVisible?'with-film-guides':''}`} ref={stageHost}>
          <div className={`comparison-stage ${showComparison&&comparisonMode==='split'?'split':''}`}>
            <div className={`comparison-pane ${showComparison&&comparisonMode==='b'?'pane-hidden':''} ${picking?.side==='a'?'picking':''}`}><div className="viewport" ref={host} tabIndex={0} aria-label={showComparison?'Environment A scene':'Interactive product scene'}/>{showComparison&&<div className="comparison-view-label"><b>A</b><span>{labels.a}</span></div>}</div>
            <div className={`comparison-pane ${!showComparison||comparisonMode==='a'?'pane-hidden':''} ${picking?.side==='b'?'picking':''}`}><div className="viewport" ref={hostB} aria-label="Environment B scene"/>{showComparison&&<div className="comparison-view-label"><b>B</b><span>{labels.b}</span></div>}</div>
          </div>
          {scene&&filmGuidesVisible&&<FilmViewportControls {...filmCamera} scene={scene} frame={frame} mode={mode} editing={layer==='Framing'} disabled={!valid||playing||busy}/>}
          {scene&&tab==='material'&&layer==='Decals'&&<UvDecalOverlay layout={uvLayout} decal={activeDecal} partName={selectedPart?.source==='scene'?partName(selectedPart.id):selectedPart?.name??'Part'} onPlace={placeDecal} onAdd={addDecal} onHover={hoverUv} onInteractionSurface={decalInteractionSurface}/>}
          {scene&&<TransformShortcuts scene={scene} frame={frame} target={transformTarget} enabled={animatorVisible&&valid&&!busy&&!materialPreview} viewport={host.current} createGesture={(target,pointer)=>viewport.current?.createTransformGesture(target,pointer,materializeAnimatedPose(transformDraft??scene,frame))??null} onStart={startTransform} onPreview={previewTransform} onCommit={commitTransform} onMode={updateTransformMode}/>}
          {materialPreview&&materialEditorVisible&&<div className="gesso-material-preview-label" role="status" aria-label="Material preview"><UiIcon name="circle"/>Preview</div>}
          {picking&&<div className="pick-hint" role="status">View {picking.side.toUpperCase()}: click {picking.kind==='floor'?'the floor':`measurement point ${calibrationDrafts[picking.side].points.length+1} of 2`}<button onClick={()=>setPicking(null)}>Cancel</button></div>}
          <div className="gesso-view-toolbar"><button onClick={resetView} title="Return to the saved shot framing">{inspecting?'Return to shot':'Shot camera'}</button><span>{inspecting?'Inspection view · shot unchanged':`${shot?.name??''} · ${((frame-1)/fps).toFixed(2)}s`}</span>{!stillFilm&&<button aria-label={playing?'Pause playback':'Play preview'} disabled={!!transformMode||!valid} onClick={()=>{if(frame===total)setFrame(1);setPlaying(value=>!value)}}>{playing?'Pause':'Play'} <kbd>Space</kbd></button>}</div>
          {!valid&&(!samples.length||validationError)&&<div className="gesso-render-status" role="status">{validationError?'Preview needs attention':evaluating?'Updating scene…':'Opening scene…'}</div>}
        </div>
        <div className="timeline-reveal" aria-hidden={!timelineVisible} inert={!timelineVisible}>{animatorVisible&&scene?<KeyframeEditor scene={transformDraft??scene} componentId={transformPart?.componentId??null} frame={frame} onFrame={previewFrame} onChange={change} playing={playing} onPlay={()=>{if(frame===total)setFrame(1);setPlaying(value=>!value)}} disabled={!!transformMode||!valid||busy} scope={positionSpace} onScopeChange={setPositionSpace}/>:<section className="timeline" aria-label="Shot timeline"><div className="transport"><span className="timecode">{((frame-1)/fps).toFixed(2)} / {(total/fps).toFixed(2)}s</span><div className="transport-right"><NumberField label="Frame" value={frame} onChange={n=>{setPlaying(false);setFrame(Math.max(1,Math.min(total,Math.round(n))))}} min={1} max={total} step={1}/><span>Space to play · ← → scrub</span></div></div><input className="scrubber" aria-label="Scrub scene" type="range" min={1} max={total} value={frame} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value))}}/><div className="shots">{scene?.shots.map((item:any,i:number)=><button className={`shot ${item.id===shot?.id?'selected':''}`} key={item.id} onClick={()=>{setPlaying(false);setFrame(item.startFrame)}} style={{flex:item.endFrame-item.startFrame+1}}><span>{String(i+1).padStart(2,'0')}　{item.name}</span><small>{((item.endFrame-item.startFrame+1)/fps).toFixed(1)}s</small></button>)}</div></section>}</div>
      </main>
      <aside className="gesso-sidebar gesso-material-editor" aria-label="Material preset editor" aria-hidden={!materialEditorVisible} inert={!materialEditorVisible}>
        <div className="gesso-sidebar-content gesso-material-editor-content" ref={setMaterialEditorHost}/>
      </aside>
    </div>
    {notice&&<div className="gesso-notice" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={()=>setNotice('')}>×</button></div>}
    <div className="gesso-small-screen"><span className="gesso-wordmark">gesso<span>studio</span></span><p>Open the editor in a wider window.</p><span>900 px gives the product and its controls room to work.</span></div>
  </div>

}
export default function App(){return location.pathname==='/capture'?<Capture/>:<Editor/>}
