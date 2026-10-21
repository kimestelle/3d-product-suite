import {FrameWindow, useFrameSource, useFrameInvalidation} from './DynamicFrame';
import {roundedFrameNodes} from './frameGeometry';
import StudioEntry, {type StudioEditorProps} from './StudioEntry';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { equalJson, canRedo, canUndo, commitHistory, createHistory, redoHistory, undoHistory } from './state';
import { createViewport, type ViewportPart } from './viewport';
import type {MaterialHover, MaterialPreview} from './materials';
import { resolveHierarchy, sceneParts } from './hierarchy';
import ProductPanel, { type ProductLayer } from './ProductPanel';
import WorldPanel, { type WorldLayer } from './WorldPanel';
import FilmPanel from './FilmPanel';
import CameraPanel from './CameraPanel';
import {FilmObjects, FilmInspector, FilmTimeline, FilmShotHeader, type FilmWorkspaceProps} from './FilmWorkspace';
import FilmPoseInspector from './FilmPoseInspector';
import {FilmClipDetails} from './FilmClipDetails';
import {addImageShot, closeSequenceGaps, exactShotAtFrame, sequenceEnd, shotAtFrame} from './sequence';
import {FrameSetupObjects, FrameSetupInspector} from './NewFrameFlow';
import {createFrameSetup, setFrameObjects, setFrameCamera, patchFrameMotions, type FrameSetup} from './frameSetup';
import {listMotions, motionLabel} from './filmMotion';
import {timelineMotions} from './filmTimelineModel';
import {legacyMotions} from './FilmWorkspaceShared';
import './film-shell.css';
import ExportPanel from './ExportPanel';
import {combinedExportJobs, normalizePairExportJob, exportBlockReason, type ExportJob, type ExportMode, type ExportPayload} from './exportModel';
import FilmViewportControls from './FilmViewportControls';
import ViewportLoading from './ViewportLoading';
import {useFilmCamera} from './useFilmCamera';
import {useFilmPlayhead} from './useFilmPlayhead';
import {useFilmAudio} from './useFilmAudio';
import type {FilmGuideProjection} from './filmGuides';
import TransformShortcuts from './TransformShortcuts';
import type {TransformMode,TransformTarget} from './transforms';
import {NumberControl} from './EditorControls';
import {decalForPart, newDecal, UvDecalOverlay} from './DecalEditor';
import type {ProductDecal, UvLayout} from './decals';
import {displayPartName} from './hierarchy';
import { groups, shortcutDestination } from './navigation';
import {useEditorNavigation} from './useEditorNavigation';
import {startExportJobPolling} from './exportJobPolling';
import {resolveSaveStatus} from './saveStatus';
import EditorNavigation from './EditorNavigation';
import {UiIcon} from './UiIcon';
import {EditorMenu} from './editorMotion';
import {syncEditorDisclosureState} from './editorDisclosureState';
import './editor-motion.css';
import './editor-disclosures.css';
import KeyframeEditor from './KeyframeEditor';
import {materializeAnimatedPose} from './keyframes';
import avatar from './assets/gesso/avatar.png';
import ComparisonPanel, { emptyCalibration, type CalibrationDraft, type PickRequest } from './ComparisonPanel';
import { comparisonLabels, enableComparison, setComparisonWorld, updateWorldTransform, type ComparisonMode, type Side } from './comparison';

type Scene = any;
type Project = {id:string;name:string;scene:Scene;revisionId:string;approvedRevisionId:string|null;headRevisionId?:string};
type World = {id:string;name:string;environment:Scene};
type Job = ExportJob;
type PairJob = {id:string;kind:'still'|'reel';state:string;sourceDigest:string;sharedDigest:string;alignmentStatus:string;frame?:number;children:{a:Job;b:Job};artifacts:{name:string;url:string}[];createdAt:string;error?:string};
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

function Editor({active = true, onReady, onLoadError}: StudioEditorProps) {
  const [presented, setPresented] = useState({a: false, b: false});
  const [viewportLoading, setViewportLoading] = useState({a: false, b: false});
  const entranceReported = useRef(false);
  const entranceCallbacks = useRef({onReady, onLoadError}); entranceCallbacks.current = {onReady, onLoadError};
  const [project,setProject]=useState<Project|null>(null); const [projects,setProjects]=useState<any[]>([]);
  const [history,setHistoryState]=useState(()=>createHistory<Scene|null>(null)); const scene=history.present;
  const historyRef=useRef(history);historyRef.current=history;
  // Compute transactions before React's updater so validation errors remain catchable by controls.
  const setHistory=(update:typeof history|((previous:typeof history)=>typeof history))=>{const next=typeof update==='function'?update(historyRef.current):update;historyRef.current=next;setHistoryState(next);};
  const [worlds,setWorlds]=useState<World[]>([]);const [jobs,setJobs]=useState<Job[]>([]);
  const [pairJobs,setPairJobs]=useState<PairJob[]>([]);const [comparisonInfo,setComparisonInfo]=useState<any>(null);const [comparisonMode,setComparisonMode]=useState<ComparisonMode>('split');
  const [calibrationDrafts,setCalibrationDrafts]=useState<Record<Side,CalibrationDraft>>({a:emptyCalibration(),b:emptyCalibration()});const [picking,setPicking]=useState<PickRequest>(null);
  const [caps,setCaps]=useState<any>({}); const [samples,setSamples]=useState<any[]>([]);const [digest,setDigest]=useState('');
  const {frame,editingFrame:filmEditFrame,setFrame,setPlaybackFrame,restoreEditingFrame}=useFilmPlayhead();const [playing,setPlaying]=useState(false); const [selected,setSelected]=useState<string|null>('bottle-body');
  const [error,setError]=useState('');const [validationError,setValidationError]=useState(''); const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);const [saving,setSaving]=useState(false);const [evaluating,setEvaluating]=useState(false);
  const [showExport,setShowExport]=useState(false);const [exportMode,setExportMode]=useState<ExportMode>('still');
  const [showProductImport,setShowProductImport]=useState(false);const [productImporting,setProductImporting]=useState(false);
  const [productName,setProductName]=useState('');const [productOwner,setProductOwner]=useState('');const [productReuse,setProductReuse]=useState('');const [productSource,setProductSource]=useState('');const productFile=useRef<HTMLInputElement>(null);
  const {tab,layer,mode,setMode,navigate,chooseGroup,chooseLayer:selectLayer}=useEditorNavigation();
  const productWorkspace=tab==='product'||tab==='material';
  const filmWorkspace=tab==='renders';
  const [filmTarget,setFilmTarget]=useState('$camera');
  const [filmMotionId,setFilmMotionId]=useState<string|null>(null);
  const [filmCurves,setFilmCurves]=useState(false);
  const [frameSetup,setFrameSetup]=useState<FrameSetup|null>(null);
  const [frameSetupError,setFrameSetupError]=useState('');
  const frameSetupBaseline=useRef<{history:typeof history;frame:number;target:string;layer:string;selected:string|null;space:'world'|'local'}|null>(null);
  const [filmLegacy,setFilmLegacy]=useState(false);
  const imageFile=useRef<HTMLInputElement>(null);
  const [importingFilmImage,setImportingFilmImage]=useState(false);
  const filmReturn=useRef<{frame:number;target:string}|null>(null);
  const animatorVisible=tab==='renders'&&mode==='video'&&layer==='Animation';
  const stillFilm=tab==='renders'&&mode==='still';
  const showComparison=!!scene?.comparison&&!productWorkspace&&!filmWorkspace;
  const materialEditorVisible=!!scene&&tab==='material'&&layer==='Materials';
  const [worldObjectId,setWorldObjectId]=useState<string|null>(null);
  useEffect(()=>setWorldObjectId(null),[project?.id,scene?.sceneId]);
  const worldEditorVisible=!!scene&&tab==='world'&&layer==='Props'&&!!worldObjectId&&[scene.environment.plinth,...(scene.environment.props??[])].some((item:any)=>item.id===worldObjectId);
  const sideEditorVisible=materialEditorVisible||worldEditorVisible;
  const filmGuidesVisible=filmWorkspace&&!showComparison;
  const [filmGuide,setFilmGuide]=useState<FilmGuideProjection|null>(null);
  useEffect(()=>{if(stillFilm)setPlaying(false)},[stillFilm]);
  const [sideEditorHost,setSideEditorHost]=useState<HTMLElement|null>(null);
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
  const [sectionType,setSectionType]=useState('text');
  const editorRoot=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const root=editorRoot.current;if(!root)return;
    const toggle=(event:Event)=>{if(event.target instanceof HTMLDetailsElement)syncEditorDisclosureState(event.target)};
    root.addEventListener('toggle',toggle,true);
    return()=>root.removeEventListener('toggle',toggle,true);
  },[]);
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
  const hoverMaterial=useCallback((hover:MaterialHover|null)=>{
    viewport.current?.setMaterialHover(hover);viewportB.current?.setMaterialHover(hover);
  },[]);
  useEffect(()=>{if(!materialEditorVisible||!active||showExport)hoverMaterial(null);},[materialEditorVisible,active,showExport,hoverMaterial]);
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
  const file=useRef<HTMLInputElement>(null);const total=scene?sequenceEnd(scene):360;const fps=scene?.render.fps??24;
  const filmAudio=useFilmAudio(scene,{playing,frame,fps});
  const shot=scene?exactShotAtFrame(scene,frame):undefined;
  const filmEditShot=scene?exactShotAtFrame(scene,filmEditFrame):undefined;
  const filmSceneSelected=!!filmEditShot&&filmEditShot.kind!=='image';
  const filmSceneVisible=!!shot&&shot.kind!=='image';
  const setupShot=frameSetup?scene?.shots.find((item:any)=>item.id===frameSetup.shotId):null;
  const playbackStart=setupShot?.startFrame??1, playbackEnd=setupShot?.endFrame??total;
  const togglePlayback=()=>{if(frameRef.current>=playbackEnd||frameRef.current<playbackStart)setPlaybackFrame(playbackStart);setPlaying(value=>!value)};
  useEffect(()=>{if(!scene)return;if(filmEditFrame>total)setFrame(total);else if(frame>total)setPlaybackFrame(total);},[scene,total,filmEditFrame,frame,setFrame,setPlaybackFrame]);
  const dirty=!!scene&&!equalJson(scene,project?.scene);
  const saveStatus=resolveSaveStatus({saving,loaded:!!project,busy:busy||productImporting||importing||importingFilmImage,dirty});
  const valid=!!scene&&!!samples.length&&!evaluating&&!validationError&&evaluatedScene.current===scene;
  const visibleViewportLoading=productImporting||!validationError&&((viewportLoading.a&&(!showComparison||comparisonMode!=='b'))||(viewportLoading.b&&showComparison&&comparisonMode!=='a'));
  useEffect(() => {
    const report = () => {
      if (entranceReported.current) return;
      // The existing narrow-screen gate is a complete destination. Its hidden
      // canvases cannot present a frame until the editor has enough room.
      if (innerWidth < 900) {entranceReported.current=true;entranceCallbacks.current.onReady?.();return;}
      if (error || validationError) {entranceCallbacks.current.onLoadError?.(error || validationError); return;}
      if (valid && presented.a && (!showComparison || presented.b)) {
        entranceReported.current = true; entranceCallbacks.current.onReady?.();
      }
    };
    report();
    if (entranceReported.current) return;
    window.addEventListener('resize', report);
    return () => window.removeEventListener('resize', report);
  }, [valid, presented, showComparison, error, validationError]);
  const calibrationRef=useRef(calibrationDrafts);calibrationRef.current=calibrationDrafts;
  const calibrationKey=JSON.stringify(scene?.comparison?.calibration??{});
  const calibrationWorldKey=JSON.stringify([scene?.environment,scene?.comparison?.alternative].map(environment=>[environment?.asset?.sha256,environment?.asset?.sourceUp,environment?.revisionId]));
  useEffect(()=>{const saved=JSON.parse(calibrationKey);const draft=(side:Side):CalibrationDraft=>({floor:saved[side]?.sourceFloorPoint,points:saved[side]?.measurement?.sourcePoints??[],distance:saved[side]?.measurement?.realDistanceM?.toString()??'',yaw:''});setCalibrationDrafts({a:draft('a'),b:draft('b')});setPicking(null)},[calibrationKey,calibrationWorldKey,project?.id]);
  const change=(edit:(s:Scene)=>void)=>{setPlaying(false);setPicking(null);setNotice('');setError('');setHistory(previous=>{if(!previous.present)return previous;const next=clone(previous.present);edit(next);return commitHistory(previous,next)})};
  const resumeFilmEditing=()=>{setPlaying(false);restoreEditingFrame();};
  const changeFilm=(edit:(s:Scene)=>void)=>{resumeFilmEditing();change(edit);};
  const loadProject=(p:Project)=>{clearMaterialPreview();viewport.current?.resetFraming();viewportB.current?.resetFraming();try{localStorage.setItem('gesso.project',p.id)}catch{}setProject(p);const opened=clone(p.scene);let compacted=false,compactionError='';try{compacted=closeSequenceGaps(opened)}catch(reason){compactionError=reason instanceof Error?reason.message:'Could not close film gaps.'}setHistory(compacted?commitHistory(createHistory(p.scene),opened):createHistory(p.scene));setFilmTarget('$camera');setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);setFrameSetup(null);frameSetupBaseline.current=null;setFrameSetupError('');filmReturn.current=null;setFrame(1);setPlaying(false);setPicking(null);setError('');setValidationError('');setParts([]);setUvLayout(null);setSelectedDecalId(null);setSelected(p.scene.product.label?.componentId??p.scene.product.components[0]?.id??null);setFocused(true);setInspecting(false);setHiddenParts([]);setNotice(compacted?'Film gaps closed · Undo to restore':compactionError||'Project opened')};
  useEffect(()=>{const abort=new AbortController();api('/api/bootstrap','GET',undefined,abort.signal).then(async b=>{let remembered:string|null=null;try{remembered=localStorage.getItem('gesso.project')}catch{}let opened=b.project;if(remembered&&remembered!==opened.id&&b.projects.some((p:any)=>p.id===remembered)){try{opened=await api(`/api/projects/${remembered}`,'GET',undefined,abort.signal)}catch{}}if(abort.signal.aborted)return;loadProject(opened);setProjects(b.projects);setWorlds(b.worlds);setCaps(b.capabilities);setJobs(b.jobs)}).catch(e=>{if(!abort.signal.aborted)setError(e.message)});return()=>abort.abort()},[]);
  useEffect(()=>{const hostElement=host.current;const secondHost=hostB.current;if(!hostElement||!secondHost)return;const view=createViewport(hostElement,{studioMode:true,onPresented:()=>setPresented(value=>({...value,a:true})),onLoading:loading=>setViewportLoading(value=>({...value,a:loading})),onFilmGuide:setFilmGuide,onInteract:()=>{setPlaying(false);setInspecting(true)},onParts:setParts,onError:setValidationError,onWorldPoint:point=>pickHandler.current('a',point)});const second=createViewport(secondHost,{studioMode:true,onPresented:()=>setPresented(value=>({...value,b:true})),onLoading:loading=>setViewportLoading(value=>({...value,b:loading})),onInteract:()=>{setPlaying(false);setInspecting(true)},onError:message=>{if(sceneRef.current?.comparison)setValidationError(message)},onWorldPoint:point=>pickHandler.current('b',point)});viewport.current=view;viewportB.current=second;
    return()=>{++previewRequest.current;currentPreviewScope.current=null;view.dispose();second.dispose();viewport.current=null;viewportB.current=null}},[]);
  useEffect(()=>{if(!scene)return;const request=++newest.current;const abort=new AbortController();setEvaluating(true);setValidationError('');const timer=setTimeout(()=>{
    api('/api/evaluate','POST',{scene},abort.signal).then(async result=>{if(request!==newest.current)return;if(scene.comparison&&(!result.comparison?.a||!result.comparison?.b))throw new Error('Both environment scenes are required for comparison preview.');const sampled=result.frames[Math.min(frameRef.current-1,result.frames.length-1)];
      if(!result.comparison)viewportB.current?.clearScene();
      await Promise.all([viewport.current?.setScene(result.comparison?.a??result.scene,sampled),result.comparison?viewportB.current?.setScene(result.comparison.b,sampled):Promise.resolve()]);
      if(request!==newest.current)return;const currentFrame=Math.min(frameRef.current,result.frames.length);const currentSample=result.frames[currentFrame-1];
      await Promise.all([viewport.current?.setSample(currentSample),result.comparison?viewportB.current?.setSample(currentSample):Promise.resolve()]);
      if(request===newest.current){evaluatedScene.current=scene;transformCommitPending.current=false;flushMaterialPreviewClear();setSamples(result.frames);setDigest(result.digest);setComparisonInfo(result.comparison??null);setPlaybackFrame(currentFrame);setValidationError('');setEvaluating(false)}
    }).catch(e=>{if(request===newest.current){setValidationError(e.message);setEvaluating(false)}})
  },180);return()=>{clearTimeout(timer);abort.abort();++newest.current}},[scene]);
  useEffect(()=>{viewport.current?.setFilmContent(filmWorkspace);viewportB.current?.setFilmContent(filmWorkspace)},[filmWorkspace]);
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
  useEffect(()=>{const enabled=focused&&(tab==='product'||tab==='material'&&layer==='Decals');viewport.current?.setPartFocus(enabled);viewportB.current?.setPartFocus(enabled)},[focused,tab,layer,animatorVisible]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer)},[notice]);
  useEffect(()=>{const outside=(e:PointerEvent)=>{if(!menuHost.current?.contains(e.target as Node))setMenu(null)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[]);
  useEffect(()=>{
    if(!active)return;
    return startExportJobPolling({
      readJobs:signal=>api('/api/jobs','GET',undefined,signal),
      readPairs:signal=>api('/api/comparison-renders','GET',undefined,signal),
      onJobs:next=>setJobs(previous=>equalJson(previous,next)?previous:next),
      onPairs:next=>setPairJobs(previous=>equalJson(previous,next)?previous:next),
    });
  },[active]);
  useEffect(()=>{viewport.current?.setWorldPickEnabled(picking?.side==='a');viewportB.current?.setWorldPickEnabled(picking?.side==='b')},[picking]);
  useEffect(()=>{const hidden=()=>{if(document.hidden)setPlaying(false)};document.addEventListener('visibilitychange',hidden);
    const observer=new IntersectionObserver(entries=>{if(!entries[0]?.isIntersecting)setPlaying(false)});if(stageHost.current)observer.observe(stageHost.current);
    return()=>{document.removeEventListener('visibilitychange',hidden);observer.disconnect()}},[]);
  // While the soundtrack is audibly running it is the master clock; the frame clock only fills in before, after and while it buffers.
  useEffect(()=>{if(!playing)return;setPicking(null);let raf=0;let start=performance.now();let first=frame;let previous=frame;filmAudio.play((first-1)/fps);const tick=(time:number)=>{let next=first+Math.floor((time-start)/1000*fps);const heard=filmAudio.sync((next-1)/fps);if(heard!==null){next=Math.max(previous,1+Math.floor(heard*fps+1e-6));first=next;start=time}previous=next;if(next>playbackEnd){setPlaying(false);setPlaybackFrame(playbackEnd);return}setPlaybackFrame(next);raf=requestAnimationFrame(tick)};raf=requestAnimationFrame(tick);return()=>{cancelAnimationFrame(raf);filmAudio.pause()}},[playing,fps,playbackEnd,filmAudio]);
  useEffect(()=>{if(!active||showExport)return;const key=(e:KeyboardEvent)=>{const target=e.target as HTMLElement;if(e.defaultPrevented||transformModeRef.current)return;if(e.isComposing||['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable)return;
    const destination=shortcutDestination(e,tab,mode);if(destination){e.preventDefault();if(target?.closest('.timeline')){const label=destination.group?groups.find(group=>group.id===destination.group)?.label:destination.layer;menuHost.current?.querySelector<HTMLButtonElement>(`.gesso-navrow button[aria-label="${label}"]`)?.focus()}if(destination.group)chooseGroup(destination.group);if(destination.layer)selectLayer(destination.layer);setMenu(null);return}
    if(!e.altKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyF'){e.preventDefault();setPlaying(false);if(e.shiftKey){setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming()}else{setInspecting(true);viewport.current?.frameSelection();viewportB.current?.frameSelection()}return}
    if(e.key==='Escape'){setMenu(null);setPicking(null);return}
    if((e.metaKey||e.ctrlKey)&&e.code==='KeyS'){e.preventDefault();if(dirty&&!busy&&!evaluating)void save();return}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo()}
    else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo()}
    else if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&e.code==='Space'){e.preventDefault();if(valid&&!stillFilm&&!e.repeat){togglePlayback()}}
    else if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();setPlaying(false);setFrame(f=>Math.max(1,Math.min(total,f+(e.key==='ArrowRight'?1:-1))))}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[active,showExport,total,valid,tab,mode,stillFilm,dirty,busy,evaluating,scene,project,chooseGroup,selectLayer,playbackStart,playbackEnd]);
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
  const save=()=>{finishFrameSetup();return perform(async()=>{
    if(transformModeRef.current)throw new Error('Apply or cancel the transform before saving.');
    if(!project||!scene)return;
    setSaving(true);
    try{
      const result=await api(`/api/projects/${project.id}`,'PUT',{scene,expectedRevisionId:project.revisionId});
      setProject(result);
    }finally{setSaving(false)}
    setProjects(await api('/api/projects'));setNotice('Revision saved');
  });};
  const approve=()=>perform(async()=>{if(!project||dirty)throw new Error('Save this revision before approving it.');const result=await api(`/api/projects/${project.id}/approve`,'POST',{expectedRevisionId:project.revisionId});setProject(result);setNotice('Approved revision preserved')});
  const restore=()=>perform(async()=>{if(!project?.approvedRevisionId)return;const old=await api(`/api/projects/${project.id}/revisions/${project.approvedRevisionId}`);setHistory(h=>commitHistory(h,old.scene));setNotice('Approved scene restored as an editable draft')});
  const exportBlockedReason=transformMode?'Apply or cancel the transform before exporting.':materialPreview?'Save or discard the material preview before exporting.':!valid?'Wait for the current scene to finish loading.':'';
  const openExport=(nextMode:ExportMode=mode)=>{
    if(!scene||busy)return;
    if(transformModeRef.current){setTransformError('Apply or cancel the transform before exporting.');return;}
    if(materialPreviewRef.current){setMaterialPreviewError('Save or discard this material preview before exporting.');return;}
    finishFrameSetup();setPlaying(false);setPicking(null);setInspecting(false);setMenu(null);
    viewport.current?.resetFraming();viewportB.current?.resetFraming();
    setMode(nextMode);navigate('renders','Output');setExportMode(nextMode);setShowExport(true);
  };
  const submitExport=async(payload:ExportPayload):Promise<ExportJob>=>{
    if(transformModeRef.current)throw new Error('Apply or cancel the transform before exporting.');
    if(materialPreviewRef.current)throw new Error('Save or discard the material preview before exporting.');
    if(!valid||!scene||evaluatedScene.current!==sceneRef.current)throw new Error('Wait for the current scene and comparison previews to load.');
    const unavailable=exportBlockReason(caps,payload.format);if(unavailable)throw new Error(unavailable);
    setBusy(true);
    try{
      const paired=!!scene.comparison;
      const job=await api(paired?'/api/comparison-renders':'/api/renders','POST',{scene,...payload});
      if(paired){setPairJobs(previous=>[job,...previous.filter(item=>item.id!==job.id)]);return normalizePairExportJob(job);}
      setJobs(previous=>[job,...previous.filter(item=>item.id!==job.id)]);return job;
    }finally{setBusy(false);}
  };
  const controlExport=async(id:string,action:'cancel'|'resume',paired=false)=>{
    await api(`${paired?'/api/comparison-renders':'/api/jobs'}/${id}/${action}`,'POST');
    if(paired)setPairJobs(await api('/api/comparison-renders'));else setJobs(await api('/api/jobs'));
  };
  useEffect(()=>{
    if (active) return;
    setShowExport(false);setPlaying(false);setPicking(null);setMenu(null);
  },[active]);
  useEffect(()=>{if(!showExport)return;const close=()=>setShowExport(false);window.addEventListener('popstate',close);return()=>window.removeEventListener('popstate',close)},[showExport]);
  const replaceWorld=(id:string)=>change(s=>{if(id==='authored'){const e=clone(s.environment);delete e.asset;delete e.fixture;e.kind='authored';e.revisionId='neutral-studio-v1';e.displayName='Authored studio';e.provenance={source:'Original authored studio',owner:'3d-product-suite',reuseBasis:'Original project geometry',allowedExternalDestinations:[]};s.environment=e;return}const world=worlds.find(w=>w.id===id);if(!world)return;const e=clone(world.environment);e.plinth=clone(s.environment.plinth);if(s.environment.props)e.props=clone(s.environment.props);s.environment=e});
  const importFile=async()=>{const chosen=file.current?.files?.[0];if(!chosen)return;setImporting(true);setError('');try{const q=new URLSearchParams({name:worldName,owner,reuseBasis:reuse,sourceUp});const result=await fetch(`/api/worlds/import?${q}`,{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':chosen.name},body:chosen});const data=await result.json();if(!result.ok)throw new Error(data.error);setWorlds(await api('/api/worlds'));setShowImport(false);setNotice(`${data.name} imported; review its alignment before rendering`)}catch(e:any){setError(e.message)}finally{setImporting(false)}};
  const importProduct=async()=>{const chosen=productFile.current?.files?.[0];if(!chosen)return;setProductImporting(true);setError('');try{const q=new URLSearchParams({name:productName,owner:productOwner,reuseBasis:productReuse,source:productSource});const result=await fetch(`/api/products/import?${q}`,{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':chosen.name},body:chosen});const data=await result.json();if(!result.ok)throw new Error(data.error);loadProject(data);setProjects(await api('/api/projects'));setShowProductImport(false);setNotice(chosen.name.toLowerCase().endsWith('.blend')?['Blender product imported at its saved frame. Materials use glTF-compatible settings.',...(data.scene?.product?.metadata?.blendImport?.warnings??[])].join(' '):'Product imported with its original geometry and materials.')}catch(e:any){setError(e.message)}finally{setProductImporting(false)}};
  const generate=()=>perform(async()=>{const result=await api('/api/github-worlds/generate','POST',{imageUrl,preset,budgetCredits:creditLimit});setNotice(`World comparison submitted to GitHub Actions. Experiment ${result.id.slice(0,8)}. Both final alternatives will be meshes.`);setRemoteRuns(await api('/api/github-worlds/runs'))});
  const refreshRuns=()=>perform(async()=>{setRemoteRuns(await api('/api/github-worlds/runs'))});
  const importRun=(id:number)=>perform(async()=>{await api(`/api/github-worlds/runs/${id}/import`,'POST');setWorlds(await api('/api/worlds'));setNotice('World Labs mesh, Gaussian-derived mesh, and native splat imported. Review alignment before approval.')});
  const labels=scene?comparisonLabels(scene):{a:'Environment A',b:'Environment B'};
  const groupName=groups.find(item=>item.id===tab)!.label;
  const toggleVisibility=(id:string)=>setHiddenParts(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const framePart=()=>{setPlaying(false);setInspecting(true);viewport.current?.frameSelection();viewportB.current?.frameSelection()};
  const frameProp=(id:string)=>{setPlaying(false);setInspecting(true);viewport.current?.frameWorldObject(id);viewportB.current?.frameWorldObject(id)};
  const resetView=()=>{setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming()};
  const undo=()=>{if(frameSetupBaseline.current){discardFrameSetup(true);return;}setPlaying(false);setPicking(null);setHistory(undoHistory)};
  const redo=()=>{finishFrameSetup();setPlaying(false);setPicking(null);setHistory(redoHistory)};
  const timelineVisible=filmWorkspace&&!stillFilm||(!stillFilm&&!(tab==='material'&&layer==='Decals')&&(showTimeline??tab==='renders'));
  const invalidateFrame=useFrameInvalidation();
  const studioFrameStyle=useRef({ground:'#131313',radius:20});
  useFrameSource('studio',()=>{
    const element=stageHost.current;
    if(!element)return null;
    const box=element.getBoundingClientRect();
    const {ground,radius}=studioFrameStyle.current;
    if(innerWidth<900)return {nodes:roundedFrameNodes({left:0,top:0,right:innerWidth,bottom:innerHeight}),
      ground,fill:ground,halo:{color:ground,blur:0,spread:0,opacity:0}};
    if(!box.width||!box.height)return null;
    const radii=sideEditorVisible||filmWorkspace?radius:{topLeft:radius,topRight:0,
      bottomLeft:timelineVisible?radius:0,bottomRight:animatorVisible?radius:0};
    return {nodes:roundedFrameNodes(box,radii),ground,fill:'#252525',
      halo:{color:ground,blur:0,spread:0,opacity:0}};
  });
  useLayoutEffect(()=>{
    const element=stageHost.current;
    if(!element)return;
    const styles=getComputedStyle(element);
    studioFrameStyle.current={ground:styles.getPropertyValue('--chrome').trim()||'#131313',
      radius:parseFloat(styles.getPropertyValue('--gesso-radius-viewport'))||20};
    invalidateFrame('studio');
  },[active,sideEditorVisible,filmWorkspace,timelineVisible,animatorVisible,filmCurves,filmLegacy,showComparison,comparisonMode,invalidateFrame]);
  const previewFrame=(next:number)=>{setPlaying(false);setFrame(next)};
  const filmCamera=useFilmCamera({scene,samples:valid?samples:[],frame:filmWorkspace?filmEditFrame:frame,mode,active:active&&filmSceneSelected&&filmGuidesVisible&&filmTarget==='$camera'&&layer!=='Output',enabled:active&&valid&&!playing&&!busy&&(!filmWorkspace||filmSceneSelected&&frame===filmEditFrame),guide:filmGuide,viewport,onChange:changeFilm,onFrame:previewFrame,onResetView:resetView});
  const activeDecal=decalForPart(scene,selected,selectedDecalId);
  const selectedPart=parts.find(part=>part.id===selected)??sceneParts(scene).find(part=>part.id===selected);
  const transformPart=selectedPart??(parts.length?parts:sceneParts(scene))[0];
  const transformTarget:TransformTarget|null=filmWorkspace&&filmTarget==='$camera'?null:positionSpace==='world'?{kind:'product'}:
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
  const productPanel=scene?<ProductPanel workspace={tab==='renders'?'animation':tab==='material'?'material':'product'} key={`${project?.id ?? ''}:${scene.sceneId}`} onPreview={previewMaterial} onMaterialHover={hoverMaterial} editorHost={materialEditorVisible?sideEditorHost:null} positionSpace={positionSpace} onPositionSpace={setPositionSpace} transformMode={transformMode} scene={transformDraft??scene} partId={selected} parts={parts} layer={layer as ProductLayer} onSelect={choosePart} onChange={change} onLayer={name=>chooseLayer(name)} focused={focused} onToggleFocus={()=>setFocused(value=>!value)} onFrame={framePart} hiddenParts={hiddenParts} onToggleVisibility={toggleVisibility} onImport={()=>setShowProductImport(value=>!value)} frame={frame} onPreviewFrame={previewFrame} decal={activeDecal} uvLayout={uvLayout} onAddDecal={addDecal} onSelectDecal={setSelectedDecalId}/>:null;
  const filmEntries=scene&&filmEditShot?listMotions(scene,filmEditShot.id):[];
  const filmTimelineRows=scene?timelineMotions(scene,filmTarget).length+legacyMotions(scene).filter(item=>item.target===filmTarget).length:0;
  const filmOwners=filmEntries.filter(entry=>entry.motion.enabled&&entry.motion.target===filmTarget);
  const filmCameraOwners=filmEntries.filter(entry=>entry.motion.enabled&&entry.motion.target==='$camera');
  useEffect(()=>{if(!filmWorkspace)return;if(layer==='Framing'&&filmTarget!=='$camera'){setFilmTarget('$camera');setFilmMotionId(null);setFilmLegacy(false);}else if(layer==='Animation'&&filmTarget==='$camera'){setFilmTarget('$product');setPositionSpace('world');}else if(layer==='Sequence'){setFilmLegacy(false);setFilmCurves(false);}},[tab,layer]);
  const chooseFilmTarget=(id:string)=>{
    finishFrameSetup();resumeFilmEditing();setFilmTarget(id);setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);
    if(id==='$product')setPositionSpace('world');
    else if(id!=='$camera'){setPositionSpace('local');setSelected(id);}
    navigate('renders',id==='$camera'?'Framing':'Animation');
  };
  const chooseFilmMotion=(id:string|null)=>{
    finishFrameSetup();resumeFilmEditing();setFilmMotionId(id);setFilmLegacy(false);if(!id){setFilmCurves(false);return;}
    const item=filmEntries.find(entry=>entry.motion.id===id);
    if(item){setFilmTarget(item.motion.target);setPositionSpace(item.motion.target==='$product'?'world':'local');if(!item.motion.target.startsWith('$'))setSelected(item.motion.target);navigate('renders',item.motion.target==='$camera'?'Framing':'Animation');}
    resetView();
  };
  useEffect(()=>{
    if(filmMotionId&&!filmEntries.some(entry=>entry.motion.id===filmMotionId)){setFilmMotionId(null);setFilmCurves(false);}
    if(scene&&filmTarget[0]!=='$'&&!scene.product.components.some((part:any)=>part.id===filmTarget))setFilmTarget('$camera');
  },[filmEditShot?.id,scene,filmMotionId,filmTarget]);
  function finishFrameSetup(){
    const baseline=frameSetupBaseline.current;
    if(!baseline)return;
    frameSetupBaseline.current=null;
    setHistory(commitHistory(baseline.history,historyRef.current.present));
    setFrameSetup(null);setFrameSetupError('');
  }
  function discardFrameSetup(undoable=false){
    const baseline=frameSetupBaseline.current;if(!baseline)return;
    const draft=historyRef.current.present;frameSetupBaseline.current=null;
    setHistory(undoable?undoHistory(commitHistory(baseline.history,draft)):baseline.history);
    setFrameSetup(null);setFrameSetupError('');setPlaying(false);setFrame(baseline.frame);
    setFilmTarget(baseline.target);setSelected(baseline.selected);setPositionSpace(baseline.space);
    setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);navigate('renders',baseline.layer);resetView();
  }
  function beginFrameSetup(){
    if(!scene||!valid||busy)return;
    finishFrameSetup();resumeFilmEditing();
    try{
      const draft=clone(scene), setup=createFrameSetup(draft,shotAtFrame(scene,filmEditFrame)?.id);
      frameSetupBaseline.current={history:historyRef.current,frame:filmEditFrame,target:filmTarget,layer,selected,space:positionSpace};
      change(next=>{next.shots=draft.shots;next.render=draft.render});
      setFrameSetup(setup);setFrameSetupError('');setFilmTarget('$product');setPositionSpace('world');
      setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);
      setFrame(draft.shots.find((item:any)=>item.id===setup.shotId).startFrame);navigate('renders','Animation');resetView();
    }catch(reason){setError(reason instanceof Error?reason.message:'Could not create this frame.');}
  }
  const editFrameSetup=(edit:(draft:Scene,setup:FrameSetup)=>FrameSetup)=>{
    if(!frameSetup||!scene||!valid||busy)return;
    try{
      const draft=clone(scene),nextSetup=edit(draft,frameSetup);
      change(next=>{next.shots=draft.shots;next.render=draft.render});setFrameSetup(nextSetup);setFrameSetupError('');
      setFilmMotionId(nextSetup.stage==='camera'?nextSetup.cameraMotionId:nextSetup.objectMotionIds[0]??null);
      return nextSetup;
    }catch(reason){setFrameSetupError(reason instanceof Error?reason.message:'This change could not be applied.');}
  };
  const setupSample=()=>samples.find((sample:any)=>sample.frame===setupShot?.startFrame);
  const setupCamera=(target:string,kind:FrameSetup['cameraKind'])=>editFrameSetup((draft,setup)=>setFrameCamera(draft,setup,target,kind,setupSample()));
  const setupStage=(stage:FrameSetup['stage'])=>{
    if(!frameSetup||!setupShot)return;
    if(stage==='camera'){
      const next=setupCamera(frameSetup.cameraTarget,frameSetup.cameraKind);if(!next)return;
      setFrameSetup({...next,stage});setFilmTarget('$camera');setFilmMotionId(next.cameraMotionId);navigate('renders','Framing');
      filmCamera.onTargetChange(next.cameraTarget==='$product'?'':next.cameraTarget);
    }else{
      setFrameSetup({...frameSetup,stage});const target=frameSetup.targets[0]??'$product';
      setFilmTarget(target);setPositionSpace(target==='$product'?'world':'local');if(!target.startsWith('$'))setSelected(target);
      setFilmMotionId(frameSetup.objectMotionIds[0]??null);navigate('renders','Animation');
    }
    setPlaying(false);setFrame(setupShot.startFrame);resetView();
  };
  const frameSetupProps=frameSetup&&scene&&setupShot?{scene,setup:frameSetup,disabled:!valid||busy||!!transformMode,error:frameSetupError,
    onTargets:(targets:string[])=>{const next=editFrameSetup((draft,setup)=>setFrameObjects(draft,setup,targets,setup.objectKind));if(next){const target=next.targets[0]??'$product';setFilmTarget(target);setPositionSpace(target==='$product'?'world':'local');if(!target.startsWith('$'))setSelected(target);}},
    onObjectKind:(kind:FrameSetup['objectKind'])=>editFrameSetup((draft,setup)=>setFrameObjects(draft,setup,setup.targets,kind)),
    onCameraTarget:(target:string)=>{if(setupCamera(target,frameSetup.cameraKind))filmCamera.onTargetChange(target==='$product'?'':target);},
    onCameraKind:(kind:FrameSetup['cameraKind'])=>setupCamera(frameSetup.cameraTarget,kind),
    onPatchMotion:(patch:Parameters<typeof patchFrameMotions>[2])=>editFrameSetup((draft,setup)=>{patchFrameMotions(draft,setup,patch);return setup;}),
    onStage:setupStage,onComplete:finishFrameSetup,onDiscard:()=>discardFrameSetup()}:null;
  useEffect(()=>{
    if(frameSetup&&(!active||!filmWorkspace||stillFilm||filmEditShot?.id!==frameSetup.shotId||layer!==(frameSetup.stage==='objects'?'Animation':'Framing')))finishFrameSetup();
  },[active,filmWorkspace,stillFilm,layer,filmEditShot?.id,frameSetup?.shotId,frameSetup?.stage]);
  const filmProps:FilmWorkspaceProps={scene,frame,editingFrame:filmEditFrame,onFrame:previewFrame,onChange:changeFilm,selectedTarget:filmTarget,onTargetChange:chooseFilmTarget,
    selectedMotionId:mode==='still'?null:filmMotionId,onMotionSelect:chooseFilmMotion,mode,playing,
    onPlay:()=>{resetView();togglePlayback()},onCreateShot:beginFrameSetup,disabled:showExport||!!transformMode||!valid||busy||importingFilmImage,
    editCurves:filmCurves,onEditCurves:setFilmCurves,onResetView:resetView,
    onOutput:()=>{finishFrameSetup();resumeFilmEditing();setFilmMotionId(null);chooseLayer('Output')},
    onLegacyAnimation:()=>{resumeFilmEditing();setFilmLegacy(true);setFilmCurves(false);setFilmMotionId(null);navigate('renders','Animation');}};
  const editFilmMechanism=()=>{filmReturn.current={frame:filmEditFrame,target:filmTarget};if(!filmTarget.startsWith('$'))setSelected(filmTarget);navigate('product','Model');};
  const returnToFilm=()=>{const saved=filmReturn.current;filmReturn.current=null;if(saved){chooseFilmTarget(saved.target);previewFrame(saved.frame);}};
  const filmPoseContent=scene?(filmTarget==='$camera'?<>
    {filmCameraOwners.length>0&&<div className="film-owner-note"><span>Position follows {motionLabel(filmCameraOwners[0].motion).toLowerCase()}. Pause that motion to edit the base view.</span><button type="button" onClick={()=>chooseFilmMotion(filmCameraOwners[0].motion.id)}>Edit motion</button></div>}
    <fieldset className="film-camera-fields" disabled={!!filmCameraOwners.length||busy||!valid}><CameraPanel scene={scene} frame={filmEditFrame} mode={mode} embedded cameraEnd={filmCamera.end} onCameraEndChange={filmCamera.onEndChange} viewportControls cameraTargetId={filmCamera.targetId} onCameraTargetChange={filmCamera.onTargetChange} samples={valid?samples:[]} onChange={changeFilm} onFrame={previewFrame} onResetView={resetView}/></fieldset>
  </>:<FilmPoseInspector scene={scene} frame={filmEditFrame} target={filmTarget} onChange={changeFilm} onMotionSelect={chooseFilmMotion} disabled={busy||!valid}/> ):null;
  const importFilmImage=async()=>{
    const chosen=imageFile.current?.files?.[0];if(imageFile.current)imageFile.current.value='';
    const source=sceneRef.current;if(!chosen||!source)return;
    finishFrameSetup();setPlaying(false);setImportingFilmImage(true);setError('');
    try{
      const result=await fetch('/api/film/images/import',{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':chosen.name},body:chosen});
      const asset=await result.json();if(!result.ok)throw new Error(asset.error||'The image could not be imported.');
      if(sceneRef.current!==source)throw new Error('The scene changed during import. Add the image again to place it in this version.');
      const draft=clone(source),id=addImageShot(draft,asset,chosen.name.replace(/\.[^.]+$/,''),shotAtFrame(source,filmEditFrame)?.id);
      change(next=>{next.shots=draft.shots;next.render=draft.render});
      setFrame(draft.shots.find((item:any)=>item.id===id).startFrame);setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);setMode('video');navigate('renders','Sequence');resetView();
      setNotice('Image added to film');
    }catch(reason){setError(reason instanceof Error?reason.message:'The image could not be imported.');}
    finally{setImportingFilmImage(false);}
  };
  const chooseFilmImage=()=>imageFile.current?.click();
  const filmClipProps={...filmProps,onImportImage:chooseFilmImage,importingImage:importingFilmImage};
  useEffect(()=>{if(!filmSceneSelected){setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false)}},[filmSceneSelected]);
  const railWidth=340;
  return <div className="studio gesso-studio" ref={editorRoot} data-section-type={sectionType} style={{'--rail-width':`${railWidth}px`} as React.CSSProperties}>
    <input hidden type="file" ref={imageFile} accept="image/png,image/jpeg,image/webp" aria-label="Film image file" onChange={()=>{void importFilmImage()}}/>
    <header className="gesso-topbar" ref={menuHost} data-frame-outside>
      <div className="gesso-appbar">
        <a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a>
        <nav className="gesso-appmenus" aria-label="Application">
          {['File','Edit','View'].map(name=><button key={name} aria-expanded={menu===name} onClick={()=>setMenu(menu===name?null:name)}>{name}</button>)}
          {['Plugins','Widgets'].map(name=><button key={name} className="gesso-reserved-menu" disabled title={`${name} are not available in this prototype`}>{name}</button>)}
        </nav>
        <div className="gesso-header-actions">
          <button className="gesso-header-icon" aria-label="Undo" title="Undo (⌘/Ctrl Z)" disabled={!canUndo(history)} onClick={undo}><UiIcon name="undo"/></button>
          <button className="gesso-header-icon" aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" disabled={!canRedo(history)} onClick={redo}><UiIcon name="redo"/></button>
          <button className="gesso-header-icon" aria-label="History" title="History" aria-expanded={menu==='History'} onClick={()=>setMenu(menu==='History'?null:'History')}><UiIcon name="history"/></button>
          <>{saveStatus!=='unsaved' ? <span className="gesso-save-status" data-state={saveStatus} role="status" title={saveStatus==='saved'?'Saved locally':saveStatus==='saving'?'Saving revision':saveStatus==='opening'?'Opening campaign':'Operation in progress'}><UiIcon name={saveStatus==='saved'?'check':'loader'}/>{{saved:'Saved',saving:'Saving…',opening:'Opening…',working:'Working…'}[saveStatus]}</span> : <button className="gesso-save" disabled={!!transformMode||busy||!project||evaluating} onClick={save} title={materialPreview?'Save the material preset first to include its preview in this revision':'Save revision (⌘/Ctrl S)'}>Save</button>}</>
          <button className="gesso-export-entry" aria-haspopup="dialog" disabled={!scene||busy} onClick={()=>openExport()}>Export <span className="gesso-ui-icon gesso-export-arrow" aria-hidden="true"/></button>
          <img className="gesso-avatar" src={avatar} alt=""/>
        </div>
      </div>
      <EditorNavigation group={tab} onGroup={group=>{chooseGroup(group);setMenu(null)}} mode={mode} onMode={next=>{resumeFilmEditing();setMode(next);setMenu(null)}}/>
      <EditorMenu name={menu} onClose={()=>setMenu(null)}>{shownMenu=><>
        {shownMenu==='File'&&<><div className="gesso-menu-heading">{project?.name??'Opening project…'}</div><button disabled={!!transformMode||!dirty||busy||evaluating} onClick={()=>{void save();setMenu(null)}}>Save revision <kbd>⌘ S</kbd></button><button onClick={()=>{chooseGroup('product');setShowProductImport(true);setMenu(null)}}>Import product GLB</button><button disabled={!scene||busy} aria-haspopup="dialog" onClick={()=>openExport()}>Export…</button>    <div className="project-switch"><Field label="Campaign"><select aria-label="Campaign" title={dirty?'Save this revision before switching campaigns':undefined} disabled={busy||dirty} value={project?.id??''} onChange={e=>openCampaign(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>{dirty&&<p className="gesso-note">Save this revision to switch campaigns.</p>}<button className="text-button" disabled={busy} onClick={()=>perform(async()=>{const p=await api('/api/projects','POST',{name:`Campaign ${projects.length+1}`,scene});loadProject(p);setProjects(await api('/api/projects'))})}>＋ Duplicate as new campaign</button></div>
</>}
        {shownMenu==='Edit'&&<><button disabled={!canUndo(history)} onClick={undo}>Undo <kbd>⌘ Z</kbd></button><button disabled={!canRedo(history)} onClick={redo}>Redo <kbd>⇧ ⌘ Z</kbd></button></>}
        {shownMenu==='View'&&<><Field label="Section headings"><select value={sectionType} onChange={event=>setSectionType(event.target.value)}><option value="text">Halyard Text</option><option value="micro">Halyard Micro</option><option value="display">Halyard Display</option></select></Field>{!stillFilm&&!filmWorkspace&&!(tab==='material'&&layer==='Decals')&&<button onClick={()=>{setShowTimeline(!timelineVisible);setMenu(null)}}>{timelineVisible?'Hide':'Show'} timeline</button>}{(tab==='product'||tab==='material'&&layer==='Decals')&&<button onClick={()=>{setFocused(v=>!v);setMenu(null)}}>{focused?'Show assembly':'Focus selected part'}</button>}<button onClick={()=>{framePart();setMenu(null)}}>Frame selected part <kbd>F</kbd></button><button onClick={()=>{resetView();setMenu(null)}}>Return to shot camera <kbd>⇧ F</kbd></button><p className="gesso-note">Option / Alt 1–4 selects a step.<br/>Option / Alt {stillFilm?'5–6':'5–8'} opens its controls.<br/>Drag to orbit. Shift-drag to pan.<br/>Scroll to zoom.</p><a href="/about">About gesso</a><a href="/aperture">Form + light</a></>}
        {shownMenu==='History'&&<><div className="gesso-menu-heading">{project?.name}</div><p className="gesso-note">{history.past.length} undo steps · {history.future.length} redo steps</p><button disabled={busy||dirty} onClick={approve}>Approve saved revision</button><button disabled={!project?.approvedRevisionId||busy} onClick={restore}>Restore approved scene</button><p className="gesso-note">{dirty?'Unsaved changes':'Current revision saved locally'}</p></>}
      </>}</EditorMenu>
    </header>
    <div className={`gesso-workspace ${sideEditorVisible?'with-material-editor':''} ${filmWorkspace?'with-film-workspace':''} ${filmWorkspace&&!stillFilm?'film-has-timeline':''} ${filmTimelineRows>0?'film-has-motions':''} ${filmCurves?'film-curves-open':''} ${filmLegacy?'film-legacy-open':''}`} style={{'--film-track-rows':Math.min(filmTimelineRows,3)} as React.CSSProperties}>
      <aside className="gesso-sidebar" data-frame-outside aria-label={`${groupName} controls`}>
        {tab!=='product'&&!filmWorkspace&&<h1 className="gesso-panel-title">{groupName}</h1>}
        {scene&&filmWorkspace&&<FilmShotHeader scene={scene} frame={filmEditFrame}/>}
        {scene&&filmWorkspace&&filmEditShot&&shot?.id!==filmEditShot.id&&<button type="button" className="film-return-context" onClick={()=>{resumeFilmEditing();resetView()}}>Return to {filmEditShot.kind==='image'?'Image':'Scene'} {String(scene.shots.indexOf(filmEditShot)+1).padStart(2,'0')}</button>}
        <div className={`gesso-sidebar-content gesso-condensed-sidebar ${tab==='product'&&showProductImport?'has-import':''}`}>
          {transformError&&<div className="message error" role="alert">{transformError}</div>}{materialEditorVisible&&materialPreviewError&&<div className="message error" role="alert">Material preview: {materialPreviewError}</div>}{validationError&&<div className="message error" role="alert">{validationError}</div>}{error&&<div className="message error" role="alert">{error}</div>}
          {!scene&&<p className="gesso-note">{error?'The project could not be opened.':'Opening project…'}</p>}
          {scene&&productWorkspace&&productPanel}{tab==='product'&&filmReturn.current&&<button type="button" className="film-return" onClick={returnToFilm}>Return to shot</button>}
          {tab==='product'&&<>{showProductImport&&<div className="import-form control-section"><div className="gesso-section-heading">Import product <button aria-label="Close import" onClick={()=>setShowProductImport(false)}>×</button></div><div className="gesso-import-body"><Field label="Product name"><input value={productName} onChange={e=>setProductName(e.target.value)}/></Field><Field label="Product owner"><input value={productOwner} onChange={e=>setProductOwner(e.target.value)}/></Field><Field label="Source URL or reference"><input value={productSource} onChange={e=>setProductSource(e.target.value)}/></Field><Field label="Usage permission or license"><input value={productReuse} onChange={e=>setProductReuse(e.target.value)}/></Field><p className="small-copy">GLB or Blender (.blend), up to 128 MB. Blender imports the active scene at its saved frame; pack textures before saving. Cameras, lights and animation are excluded. GLBs must be self-contained, centered and in meters.</p><input aria-label="Product file" type="file" accept=".glb,.blend" ref={productFile}/><button disabled={!productName||!productOwner||!productReuse||!productSource||productImporting} onClick={importProduct}>{productImporting?'Importing…':'Import product'}</button></div></div>}</>}
          {scene&&tab==='world'&&<WorldPanel selectedObjectId={worldObjectId} onSelectObject={setWorldObjectId} editorHost={sideEditorHost} onLayer={chooseLayer} onFrameProp={frameProp} scene={scene} layer={layer as WorldLayer} worlds={worlds} onChange={change} onWorld={replaceWorld} onImport={()=>setShowImport(value=>!value)}>
            {showImport&&<div className="import-form"><Field label="World name"><input value={worldName} onChange={e=>setWorldName(e.target.value)}/></Field><Field label="Asset owner"><input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="Your company or creator"/></Field><Field label="Reuse basis"><input value={reuse} onChange={e=>setReuse(e.target.value)} placeholder="License or permission"/></Field><Field label="Source up axis"><select value={sourceUp} onChange={e=>setSourceUp(e.target.value)}><option>Y</option><option>Z</option></select></Field><input aria-label="World export file" type="file" accept=".glb,.spz,.ply" ref={file}/><button disabled={!owner||!reuse||importing} onClick={importFile}>{importing?'Importing…':'Import GLB / SPZ / PLY'}</button></div>}
            <details className="gesso-disclosure" open={scene.comparison?true:undefined}><summary>Compare environments</summary><ComparisonPanel scene={scene} worlds={worlds} info={comparisonInfo} busy={busy} ready={valid} mode={comparisonMode} drafts={calibrationDrafts} picking={picking} onMode={changeComparisonMode} onEnable={startComparison} onDisable={()=>change(s=>{delete s.comparison})} onWorld={comparisonWorld} onTransform={comparisonTransform} onDraft={draftCalibration} onPick={startPick} onCancelPick={()=>setPicking(null)} onCalibrate={applyCalibration} onReview={reviewComparison}/></details>
            <details className="gesso-disclosure"><summary>Generate environment</summary><section className="control-section"><p className="small-copy">Choose a default above to start immediately. Or generate one world and compare World Labs’ mesh with a mesh reconstructed from its Gaussians.</p><Field label="Generation preset"><select value={preset} onChange={e=>setPreset(e.target.value)}><option value="botanical-studio">Botanical studio</option><option value="warm-gallery">Warm limestone gallery</option><option value="modern-loft">Modern loft</option></select></Field><Field label="Reference image URL (optional)"><input type="url" value={imageUrl} onChange={e=>setImageUrl(e.target.value)} placeholder="https://…/reference.jpg"/></Field><p className="small-copy">Use a public HTTPS image URL, or leave blank to generate from the preset. Private image files can use the local CLI. Your key stays encrypted in GitHub.</p><NumberControl label="API credit limit" value={creditLimit} min={5080} max={6000} step={100} onChange={setCreditLimit}/><p className="small-copy">Standard world + textured mesh: about 5,080 API credits ($4.06). No automatic paid retries.</p><button className="wide" disabled={busy||!caps.githubWorldsAvailable} onClick={generate}>Generate mesh comparison ↗</button><a className="text-link" style={{marginTop:12}} href={caps.githubWorkflowUrl??'https://github.com/kimestelle/3d-product-suite/actions/workflows/worldlabs-pair.yml'} target="_blank" rel="noreferrer">Open GitHub workflow ↗</a><button className="text-button" disabled={busy} onClick={refreshRuns}>Refresh generation runs</button>{remoteRuns.map(run=><article key={run.id} className="job"><div className="job-heading"><b>{run.name}</b><span className="job-state">{run.conclusion??run.status}</span></div><a className="text-link" href={run.url} target="_blank" rel="noreferrer">View generation ↗</a>{run.conclusion==='success'&&<button className="wide" style={{marginTop:12}} disabled={busy} onClick={()=>importRun(run.id)}>Import both meshes</button>}</article>)}</section></details>
          </WorldPanel>}
          {scene&&filmWorkspace&&(frameSetupProps?<FrameSetupObjects {...frameSetupProps}/>:!filmSceneSelected?<FilmClipDetails {...filmClipProps} side="objects"/>:<FilmObjects {...filmProps}/>)}

        </div>
        <footer className="gesso-sidebar-footer"><span>{productWorkspace||animatorVisible?`${parts.length||scene?.product.components.length||0} parts · millimeters`:project?.name??'Local workspace'}</span><span title={validationError||'Live preview'}>{evaluating?'Updating…':validationError?'Needs attention':'Live'}</span></footer>
      </aside>
      <main className={`gesso-stage ${timelineVisible&&!filmWorkspace?'with-timeline':''} ${filmWorkspace?'with-film-timeline':animatorVisible?'with-keyframes':''}`} aria-label="Product window">
        {showComparison&&<div className="comparison-toolbar" data-frame-outside><div className="segmented" aria-label="Comparison display">{(['a','b','split'] as const).map(mode=><button key={mode} aria-pressed={comparisonMode===mode} onClick={()=>changeComparisonMode(mode)}>{mode==='split'?'Split':mode.toUpperCase()}</button>)}</div><span className="comparison-status">{valid&&comparisonInfo?.alignmentStatus==='reviewed'?'Placement reviewed':'Draft placement'}</span><button onClick={()=>{navigate('world','Environment')}}>Adjust placement</button></div>}
        <FrameWindow className={`viewport-wrap ${showComparison?'has-comparison':''} ${filmGuidesVisible?'with-film-guides':''}`} ref={stageHost}>
          <div className={`comparison-stage ${showComparison&&comparisonMode==='split'?'split':''}`} aria-busy={visibleViewportLoading}>
            <div className={`comparison-pane ${showComparison&&comparisonMode==='b'?'pane-hidden':''} ${picking?.side==='a'?'picking':''}`}><div className="viewport" ref={host} tabIndex={0} aria-label={showComparison?'Environment A scene':'Interactive product scene'}/>{showComparison&&<div className="comparison-view-label"><b>A</b><span>{labels.a}</span></div>}</div>
            <div className={`comparison-pane ${!showComparison||comparisonMode==='a'?'pane-hidden':''} ${picking?.side==='b'?'picking':''}`}><div className="viewport" ref={hostB} aria-label="Environment B scene"/>{showComparison&&<div className="comparison-view-label"><b>B</b><span>{labels.b}</span></div>}</div>
          </div>
          {scene&&filmGuidesVisible&&filmSceneVisible&&<FilmViewportControls {...filmCamera} scene={scene} frame={frame} mode={mode} editing={filmTarget==='$camera'&&layer!=='Output'&&!playing&&frame===filmEditFrame} disabled={!valid||playing||busy||frame!==filmEditFrame}/>}
          {scene&&tab==='material'&&layer==='Decals'&&<UvDecalOverlay layout={uvLayout} decal={activeDecal} partName={selectedPart?displayPartName(scene,selectedPart.id,selectedPart.name):'Part'} onPlace={placeDecal} onAdd={addDecal} onHover={hoverUv} onInteractionSurface={decalInteractionSurface}/>}
          {scene&&<TransformShortcuts scene={scene} frame={frame} target={transformTarget} enabled={active&&!showExport&&!frameSetup&&!playing&&frame===filmEditFrame&&filmWorkspace&&filmSceneSelected&&filmTarget!=='$camera'&&layer!=='Output'&&!filmOwners.length&&valid&&!busy&&!materialPreview} viewport={host.current} createGesture={(target,pointer)=>viewport.current?.createTransformGesture(target,pointer,materializeAnimatedPose(transformDraft??scene,frame))??null} onStart={startTransform} onPreview={previewTransform} onCommit={commitTransform} onMode={updateTransformMode}/>}
          {materialPreview&&materialEditorVisible&&<div className="gesso-material-preview-label" role="status" aria-label="Material preview"><UiIcon name="circle"/>Preview</div>}
          {picking&&<div className="pick-hint" role="status">View {picking.side.toUpperCase()}: click {picking.kind==='floor'?'the floor':`measurement point ${calibrationDrafts[picking.side].points.length+1} of 2`}<button onClick={()=>setPicking(null)}>Cancel</button></div>}
          <div className="gesso-view-toolbar">{(!filmWorkspace||filmSceneVisible)&&<button onClick={resetView} title="Return to the saved shot framing">{inspecting?'Return to shot':'Shot camera'}</button>}<span>{inspecting&&(!filmWorkspace||filmSceneVisible)?'Inspection view · shot unchanged':`${shot?.name??'Black'} · ${((frame-1)/fps).toFixed(2)}s`}</span>{filmWorkspace&&!playing&&frame!==filmEditFrame&&<button onClick={()=>previewFrame(frame)}>Edit this frame</button>}{!stillFilm&&!filmWorkspace&&<button aria-label={playing?'Pause playback':'Play preview'} disabled={!!transformMode||!valid} onClick={togglePlayback}>{playing?'Pause':'Play'} <kbd>Space</kbd></button>}</div>
          <ViewportLoading loading={visibleViewportLoading}/>
          {validationError&&<div className="gesso-render-status" role="status">Preview needs attention</div>}
        </FrameWindow>
        {!filmWorkspace&&<div className="timeline-reveal" data-frame-outside aria-hidden={!timelineVisible} inert={!timelineVisible}><section className="timeline" aria-label="Shot timeline"><div className="transport"><span className="timecode">{((frame-1)/fps).toFixed(2)} / {(total/fps).toFixed(2)}s</span><div className="transport-right"><NumberField label="Frame" value={frame} onChange={n=>{setPlaying(false);setFrame(Math.max(1,Math.min(total,Math.round(n))))}} min={1} max={total} step={1}/><span>Space to play · ← → scrub</span></div></div><input className="scrubber" aria-label="Scrub scene" type="range" min={1} max={total} value={frame} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value))}}/><div className="shots">{scene?.shots.map((item:any,i:number)=><button className={`shot ${item.id===shot?.id?'selected':''}`} key={item.id} onClick={()=>{setPlaying(false);setFrame(item.startFrame)}} style={{flex:item.endFrame-item.startFrame+1}}><span>{String(i+1).padStart(2,'0')}　{item.name}</span><small>{((item.endFrame-item.startFrame+1)/fps).toFixed(1)}s</small></button>)}</div></section></div>}
      </main>
      {scene&&filmWorkspace&&<aside className="gesso-sidebar film-inspector-rail" data-frame-outside aria-label="Film inspector" onPointerDownCapture={resumeFilmEditing} onFocusCapture={resumeFilmEditing}>
        {layer==='Output'&&!frameSetupProps&&<h2 className="film-shot-header">Output settings</h2>}
        <div className="gesso-sidebar-content">
        {frameSetupProps?<FrameSetupInspector {...frameSetupProps}/>:layer==='Output'?<div className="film-delivery-panel"><button type="button" className="film-return" onClick={()=>chooseFilmTarget(filmTarget)}>Back to shot</button><FilmPanel scene={scene} mode={mode} layer="Output" frame={filmEditFrame} onChange={changeFilm} onFrame={previewFrame} onExport={openExport} exportDisabled={busy}/></div>:!filmSceneSelected?<FilmClipDetails {...filmClipProps} side="inspector"/>:<FilmInspector {...filmProps} onEditMechanism={editFilmMechanism}>{filmPoseContent}</FilmInspector>}
      </div></aside>}
      <aside className="gesso-sidebar gesso-material-editor" data-frame-outside aria-label={worldEditorVisible?"World object editor":"Material preset editor"} aria-hidden={!sideEditorVisible} inert={!sideEditorVisible}>
        <div className="gesso-sidebar-content gesso-material-editor-content" ref={setSideEditorHost}/>
      </aside>
      {scene&&filmWorkspace&&<div className="film-timeline-dock" data-frame-outside aria-hidden={stillFilm} inert={stillFilm}><FilmTimeline {...filmProps} onImportImage={chooseFilmImage} importingImage={importingFilmImage} detailContent={filmLegacy?<div className="film-legacy-editor"><div className="film-legacy-heading"><button type="button" onClick={()=>setFilmLegacy(false)}><UiIcon name="undo"/> Back to shots</button><span>Custom keyframes · Across cuts</span></div>
            {!!filmOwners.length&&<p className="film-owner-note">Pause the selected object's motion before editing its underlying keys.</p>}
            <KeyframeEditor embedded scene={transformDraft??scene} componentId={filmTarget.startsWith('$')?null:filmTarget} frame={frame} onFrame={previewFrame} onChange={changeFilm} playing={playing} onPlay={filmProps.onPlay!} disabled={filmProps.disabled||!!filmOwners.length||frame!==filmEditFrame} scope={positionSpace} onScopeChange={space=>{setPositionSpace(space);if(space==='world')setFilmTarget('$product');else if(transformPart)setFilmTarget(transformPart.componentId)}}/>
          </div>:undefined}/></div>}
    </div>
    {showExport&&scene&&<ExportPanel scene={scene} projectName={project?.name??'gesso'} frame={frame} initialMode={exportMode} capabilities={caps} blockedReason={exportBlockedReason} jobs={combinedExportJobs(jobs,pairJobs)} currentDigest={digest} onSubmit={submitExport} onControl={controlExport} onClose={()=>setShowExport(false)} onAdjustFrame={nextMode=>{setShowExport(false);setMode(nextMode);navigate('renders','Framing');viewport.current?.resetFraming();viewportB.current?.resetFraming()}}/>}
    {notice&&<div className="gesso-notice" data-frame-outside role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={()=>setNotice('')}>×</button></div>}
    <div className="gesso-small-screen" data-frame-outside><a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a><p>Open the editor in a wider window.</p><span>900 px gives the product and its controls room to work.</span></div>
  </div>

}
const StudioEditor = memo(Editor);
const renderEditor = (props: StudioEditorProps) => <StudioEditor {...props}/>;
export default function App(){return location.pathname==='/capture'?<Capture/>:<StudioEntry renderEditor={renderEditor}/>}
