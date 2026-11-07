import {isImageFinishOnlyChange} from './viewportSceneKey';
import {canReuseViewportSamples,canUpdateViewportScene} from './viewportUpdate';
import NativeProof from './NativeProofOverlay';
import {nativeProofSize,type NativeProofInput} from './nativeProof';
import PostProcessingPanel from './PostProcessingPanel';
import {generateProductReel, productReelSettings} from './productReel';
import PresetLibraryDialog, {type PresetScope, type PresetSummary} from './PresetLibraryDialog';
import {startupProjectId} from './startupProject';
import {DRAFT_PREFIX,createDraftRecoveryWriter,newRecoveryId,readRecoveryDrafts,removeRecoveryDraft,removeSavedRecoveryDrafts,recoveryDraftIsCurrent,handoffRecoveryDraft,RecoveryDraftChangedError,type RecoveryDraft} from './draftRecovery';
import {createImportRequestGuard,sameCampaignOwner,type CampaignOwner,type ImportRequest} from './campaignTransition';
import {RecoverDraftDialog,ImportDecisionDialog} from './RecoveryDialogs';
import {isCameraHoldMotion} from './cameraMotionPresets';
import {FrameWindow, useFrameSource, useFrameInvalidation} from './DynamicFrame';
import {roundedFrameNodes} from './frameGeometry';
import StudioEntry, {type StudioEditorProps} from './StudioEntry';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { equalJson, canRedo, canUndo, commitHistory, createHistory, redoHistory, undoHistory } from './state';
import { createViewport, type PropTransformEdit, type ViewportPart } from './viewport';
import type {MaterialHover, MaterialPreview} from './materials';
import { resolveHierarchy, sceneParts } from './hierarchy';
import ProductPanel, { type ProductLayer } from './ProductPanel';
import {productImportAccept, productImportKind, productImportSettings, productImportNotice, type ProductSourceUp, type ProductSourceUnits} from './productImport';
import WorldPanel, { type WorldLayer } from './WorldPanel';
import AtlasWorldPanel from './AtlasWorldPanel';
import {worldCleanupRenderScene,canApplyWorldCleanup,type WorldCleanupOwner} from './worldCleanupPreview';
import type {WorldCleanupPreview,WorldCleanupSelection} from './WorldCleanupPanel';
import ProductFitGuide, {type ProductFitRect} from './ProductFitGuide';
import {applyProductWorldFit} from './productWorldFit';
import CameraPanel from './CameraPanel';
import FilmPanel from './FilmPanel';
import {FilmObjects, FilmInspector, FilmTimeline, FilmShotHeader, type FilmWorkspaceProps} from './FilmWorkspace';
import FilmPoseInspector from './FilmPoseInspector';
import FilmLightPose from './FilmLightPose';
import {isLightTarget, resizeProp} from './world';
import {FilmClipDetails} from './FilmClipDetails';
import {closeSequenceGaps, exactShotAtFrame, sequenceEnd, shotAtFrame} from './sequence';
import {NewSceneChooser, StaticSceneComposer, type StaticSceneDraft} from './NewSceneFlow';
import {renderFilmTextCard, isFilmTextCard} from './filmTextCard';
import {applyStaticScene} from './staticScene';
import {FrameSetupObjects, FrameSetupInspector} from './NewFrameFlow';
import {createFrameSetup, setFrameObjects, setFrameCamera, patchFrameMotions, type FrameSetup} from './frameSetup';
import {availableMotionKinds, filmCameraPoseAtFrame, listMotions, motionLabel} from './filmMotion';
import {timelineMotions} from './filmTimelineModel';
import {labelFor, legacyMotions} from './FilmWorkspaceShared';
import './film-shell.css';
import ExportPanel from './ExportPanel';
import ExportArtifactPreview,{selectExportReview,type ExportReview} from './ExportArtifactPreview';
import ExportSetupPanel, {type ExportSetupTab} from './ExportSetupPanel';
import {generateRandomSetup, type RandomSetupSettings} from './randomSetup';
import {createExportDraft, currentExportDraft, editExportDraft, type ExportDraft} from './exportDraft';
import FilmModeTabs from './FilmModeTabs';
import {ExportPreviewMask, ExportPreviewTransport} from './ExportPreview';
import './export-workspace.css';
import {combinedExportJobs, normalizePairExportJob, exportBlockReason, type ExportJob, type ExportMode, type ExportPayload} from './exportModel';
import FilmViewportControls from './FilmViewportControls';
import ViewportLoading from './ViewportLoading';
import ViewportStill from './ViewportStillOverlay';
import {useFilmCamera} from './useFilmCamera';
import {useFilmPlayhead} from './useFilmPlayhead';
import {resolveFilmPlaybackFrame} from './filmPlayback';
import {useFilmAudio} from './useFilmAudio';
import {isCameraFilmGuide, type FilmPresentationGuide} from './filmGuides';
import TransformShortcuts from './TransformShortcuts';
import {formatScalePercent,PRODUCT_SCALE_MIN,PRODUCT_SCALE_MAX,type TransformMode,type TransformTarget} from './transforms';
import {NumberControl} from './EditorControls';
import {decalForPart, newDecal, UvDecalOverlay} from './DecalEditor';
import type {ProductDecal, UvLayout} from './decals';
import {displayPartName} from './hierarchy';
import {partTargetIds,removedPartIds} from './partTargets';
import {canonicalizeDecalArtwork} from './artwork';
import { groups, shortcutDestination, type EditorDestination } from './navigation';
import {useEditorNavigation} from './useEditorNavigation';
import {startExportJobPolling} from './exportJobPolling';
import {resolveSaveStatus, type SavePreview} from './saveStatus';
import {CampaignSaveControl} from './CampaignSaveControl';
import EditorNavigation, {EditorLayerNavigation} from './EditorNavigation';
import {UiIcon} from './UiIcon';
import {EditorMenu} from './editorMotion';
import {syncEditorDisclosureState} from './editorDisclosureState';
import './editor-motion.css';
import './editor-disclosures.css';
import './dropdown-system.css';
import KeyframeEditor from './KeyframeEditor';
import {materializeAnimatedPose} from './keyframes';
import avatar from './assets/gesso/avatar.png';
import ComparisonPanel, { emptyCalibration, type CalibrationDraft, type PickRequest } from './ComparisonPanel';
import { comparisonLabels, enableComparison, setComparisonWorld, updateWorldTransform, type ComparisonMode, type Side } from './comparison';
import { canPropSupportProduct, type ResolvedObjects } from './sceneGraph';
import { demoApi } from './demo';
import { backendEditMessage, isStaticDemo } from './runtime';

type Scene = any;
type Project = {id:string;name:string;scene:Scene;revisionId:string;approvedRevisionId:string|null;headRevisionId?:string};
type WorldProtection = {
  bounds:{positionMinM:number[];positionMaxM:number[];targetMinM:number[];targetMaxM:number[];outside:'black'|'white'};
  referenceCamera:{positionM:number[];targetM:number[];focalLengthMm:number};
};
type World = {id:string;name:string;environment:Scene;cameraProtection?:WorldProtection};
type Job = ExportJob;
type ProductImportChoice={file:File;name:string;owner:string;reuseBasis:string;source:string;settings:ReturnType<typeof productImportSettings>;campaign:CampaignOwner};
type PairJob = {id:string;kind:'still'|'reel';state:string;sourceDigest:string;sharedDigest:string;alignmentStatus:string;frame?:number;children:{a:Job;b:Job};artifacts:{name:string;url:string}[];createdAt:string;error?:string};
async function api(path:string, method='GET', data?:unknown, signal?:AbortSignal) {
  if(isStaticDemo)return demoApi(path,method,data);
  const result=await fetch(path,{method,signal,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Product-Suite':'1'},body:method==='GET'?undefined:JSON.stringify(data??{})});
  const value=await result.json();
  if(result.status===401&&value.loginUrl==='/api/login'&&window.location.pathname==='/'){
    window.location.assign(`/api/login?return=${encodeURIComponent(window.location.pathname+window.location.search+window.location.hash)}`);
    throw new Error('Sign in to this workspace');
  }
  if(!result.ok) throw new Error(value.error||`Request failed (${result.status})`); return value;
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
  const [graphicsError, setGraphicsError] = useState({a:'',b:''});
  const [viewportLoading, setViewportLoading] = useState({a: false, b: false});
  const entranceReported = useRef(false);
  const entranceCallbacks = useRef({onReady, onLoadError}); entranceCallbacks.current = {onReady, onLoadError};
  const [project,setProject]=useState<Project|null>(null); const [projects,setProjects]=useState<any[]>([]);
  const projectRef=useRef<Project|null>(null);projectRef.current=project;
  const [recoveryCandidates,setRecoveryCandidates]=useState<RecoveryDraft[]>([]),[recoveryOpen,setRecoveryOpen]=useState(false);
  const [recoveryRevisionId,setRecoveryRevisionId]=useState(''),[recoverySeparate,setRecoverySeparate]=useState(false);
  const [recoveryBusy,setRecoveryBusy]=useState(false),[recoveryError,setRecoveryError]=useState(''),[draftStorageError,setDraftStorageError]=useState('');
  const recoveryOpenRef=useRef(false);recoveryOpenRef.current=recoveryOpen;
  const recoveryGeneration=useRef(0),[recoveryWriterId]=useState(newRecoveryId);
  const recoveryWriter=useRef<ReturnType<typeof createDraftRecoveryWriter>|null>(null);
  if(!recoveryWriter.current)recoveryWriter.current=createDraftRecoveryWriter(()=>window.localStorage,recoveryWriterId,setDraftStorageError);
  const [history,setHistoryState]=useState(()=>createHistory<Scene|null>(null)); const scene=history.present;
  const historyRef=useRef(history);historyRef.current=history;
  // Compute transactions before React's updater so validation errors remain catchable by controls.
  const installHistory=(next:typeof history)=>{historyRef.current=next;setHistoryState(next);};
  const setHistory=(update:typeof history|((previous:typeof history)=>typeof history))=>{if(!allowSceneEdit())return false;const next=typeof update==='function'?update(historyRef.current):update;installHistory(next);return true;};
  const [worlds,setWorlds]=useState<World[]>([]);const [jobs,setJobs]=useState<Job[]>([]);
  const jobPolling=useRef<{refresh:()=>void}|null>(null);
  const [pairJobs,setPairJobs]=useState<PairJob[]>([]);const [comparisonInfo,setComparisonInfo]=useState<any>(null);const [comparisonMode,setComparisonMode]=useState<ComparisonMode>('split');
  const [calibrationDrafts,setCalibrationDrafts]=useState<Record<Side,CalibrationDraft>>({a:emptyCalibration(),b:emptyCalibration()});const [picking,setPicking]=useState<PickRequest>(null);
  const [caps,setCaps]=useState<any>({}); const [samples,setSamples]=useState<any[]>([]);const [digest,setDigest]=useState('');
  const {frame,editingFrame:filmEditFrame,setFrame,setPlaybackFrame,restoreEditingFrame}=useFilmPlayhead();const [playing,setPlaying]=useState(false);const [loopPlayback,setLoopPlayback]=useState(false);const loopPlaybackRef=useRef(false); const [selected,setSelected]=useState<string|null>('bottle-body');
  const [error,setError]=useState('');const [validationError,setValidationError]=useState(''); const [notice,setNoticeState]=useState<{message:string;tone:'note'|'success'|'error'}|null>(null);const setNotice=(message:string,tone:'note'|'success'|'error'='note')=>setNoticeState(message?{message,tone}:null);const [busy,setBusy]=useState(false);const [saving,setSaving]=useState(false);const [evaluating,setEvaluating]=useState(false);
  // A rejected edit is feedback, not an invalid scene: keep samples/history usable.
  const allowSceneEdit=useCallback(()=>{if(!isStaticDemo)return true;setNoticeState(null);setError(backendEditMessage);return false;},[]);
  const [showProductImport,setShowProductImport]=useState(false);const [productImporting,setProductImporting]=useState(false);
  const importGuard=useRef(createImportRequestGuard()),importRequest=useRef<ImportRequest|null>(null);
  const recoveryMounted=useRef(true);
  const [importDecision,setImportDecision]=useState<ProductImportChoice|null>(null),[importDecisionBusy,setImportDecisionBusy]=useState(false),[importDecisionError,setImportDecisionError]=useState('');
  const closeProductImport=(notify=false)=>{const pending=!!importRequest.current;importGuard.current.cancel();importRequest.current=null;setProductImporting(false);setShowProductImport(false);if(notify&&pending)setNotice('Stopped opening the import. This campaign stays open; completed imports remain in the campaign library.');};
  const [productName,setProductName]=useState('');const [productOwner,setProductOwner]=useState('');const [productReuse,setProductReuse]=useState('');const [productSource,setProductSource]=useState('');const productFile=useRef<HTMLInputElement>(null);
  const [productFilename,setProductFilename]=useState('');const [productSourceUp,setProductSourceUp]=useState<ProductSourceUp>('z');const [productSourceUnits,setProductSourceUnits]=useState<ProductSourceUnits>('');
  const productFormat=productImportKind(productFilename);
  // Resolved scene-object graph (film/scene_objects.py) and world-surface placement (D160).
  const [objects,setObjects]=useState<ResolvedObjects|undefined>(undefined);const [pickingSurface,setPickingSurface]=useState(false);
  const surfacePickHandler=useRef<(side:Side,point:any)=>void>(()=>{});const surfacePickRef=useRef(false);surfacePickRef.current=pickingSurface;
  const {tab,layer,mode,setMode,navigate,chooseGroup,chooseLayer:selectLayer}=useEditorNavigation();
  const showExport=tab==='renders'&&layer==='Output';
  const [exportSetupTab,setExportSetupTab]=useState<ExportSetupTab>('current');
  const [randomSettings,setRandomSettings]=useState<{source:Scene;settings:RandomSetupSettings}|null>(null);
  const [randomDraft,setRandomDraft]=useState<ExportDraft<Scene>|null>(null);
  const [randomSetupError,setRandomSetupError]=useState('');
  const defaultSetup=useMemo(()=>scene?productReelSettings(scene):null,[scene]);
  const setupSettings=randomSettings&&randomSettings.source===scene?randomSettings.settings:defaultSetup;
  const exportDraft=currentExportDraft(randomDraft,scene,project?.id??'');
  const randomPreview=showExport&&exportSetupTab==='random';
  const cleanupScopeKey=useMemo(()=>`${project?.id??''}:${crypto.randomUUID()}`,[scene,project?.id]);
  const [cleanupOwner,setCleanupOwner]=useState<WorldCleanupOwner<Scene>|null>(null);
  const [cleanupSelection,setCleanupSelection]=useState<WorldCleanupSelection|null>(null);
  const cleanupScene=useMemo(()=>worldCleanupRenderScene(scene,project?.id??'',cleanupOwner,active,tab,layer),[scene,project?.id,cleanupOwner,active,tab,layer]);
  const cleanupPreview=cleanupScene?cleanupOwner:null;
  const cleanupPreviewRef=useRef(cleanupPreview);cleanupPreviewRef.current=cleanupPreview;
  // Candidate worlds belong to the viewport until Apply. Campaign history stays canonical.
  const renderScene=cleanupScene??(randomPreview&&exportDraft?exportDraft.scene:scene);
  useEffect(()=>{if(!cleanupScene){setCleanupOwner(null);setCleanupSelection(null);}},[scene,project?.id,active,tab,layer]);
  const [exportReview,setExportReview]=useState<ExportReview|null>(null);
  const exportReviewVisible=active&&showExport&&!!exportReview?.visible&&exportReview.source===renderScene&&exportReview.mode===mode&&exportReview.job.state==='succeeded';
  const reviewExportJob=useCallback((job:ExportJob|null,open=false)=>{
    setExportReview(previous=>selectExportReview(previous,job,renderScene,mode,open));
  },[renderScene,mode]);
  const returnToExportPreview=useCallback(()=>{
    setExportReview(previous=>previous?{...previous,visible:false}:null);
    requestAnimationFrame(()=>editorRoot.current?.querySelector<HTMLButtonElement>('.gesso-export-review-action')?.focus());
  },[]);
  useEffect(()=>{if(!showExport)setExportReview(null);},[showExport]);
  const renderSceneRef=useRef(renderScene);renderSceneRef.current=renderScene;
  const exportContextRef=useRef({showExport,tab:exportSetupTab,scene,renderScene,projectId:project?.id});
  exportContextRef.current={showExport,tab:exportSetupTab,scene,renderScene,projectId:project?.id};
  const randomSettingsDirty=!!exportDraft&&!equalJson(setupSettings,exportDraft.settings);
  const exportPlayhead=useRef<{projectId:string;frame:number}|null>(null);
  useEffect(()=>{setRandomSetupError('');},[scene,project?.id]);
  useEffect(()=>{
    if(showExport){exportPlayhead.current??={projectId:project?.id??'',frame};return;}
    const saved=exportPlayhead.current;exportPlayhead.current=null;
    if(saved&&saved.projectId===project?.id){setPlaying(false);setPlaybackFrame(Math.min(saved.frame,scene?sequenceEnd(scene):saved.frame));}
  },[showExport,project?.id]);
  const chooseExportSetup=(next:ExportSetupTab)=>{
    setPlaying(false);setExportSetupTab(next);
    setPlaybackFrame(next==='current'?Math.min(exportPlayhead.current?.frame??frame,scene?sequenceEnd(scene):frame):1);
  };
  const updateRandomSettings=(settings:RandomSetupSettings)=>{setRandomSettings({source:scene,settings});setRandomSetupError('');};
  const generateExportSetup=(chosenSettings=setupSettings)=>{
    if(cleanupPreviewRef.current){setError('Apply the cleanup preview or return to the original first.');return;}
    if(!scene||!project||!chosenSettings||busy||!allowSceneEdit())return;
    setPlaying(false);setRandomSetupError('');
    try{
      const seed=crypto.getRandomValues(new Uint32Array(1))[0];
      const referenceFrame=exportPlayhead.current?.frame??frame;
      const referenceShot=exactShotAtFrame(scene,referenceFrame);
      const referenceCamera=referenceShot&&referenceShot.kind!=='image'?filmCameraPoseAtFrame(scene,referenceShot,referenceFrame):undefined;
      const result=chosenSettings.workflow==='product-film'?generateProductReel(scene,chosenSettings,seed,{referenceCamera}):generateRandomSetup(scene,chosenSettings,seed,worlds);
      setRandomDraft(createExportDraft(scene,project.id,result,chosenSettings));setPlaybackFrame(1);
      viewport.current?.resetFraming();viewportB.current?.resetFraming();
    }catch(reason){setRandomSetupError(reason instanceof Error?reason.message:'The setup could not be generated. Try different options.');}
  };

  const exportReturn=useRef<EditorDestination>({group:'renders',layer:'Framing'});
  useEffect(()=>{if(!showExport)exportReturn.current={group:tab,layer}},[tab,layer,showExport]);
  const closeExport=()=>{setPlaying(false);navigate(exportReturn.current.group,exportReturn.current.layer);requestAnimationFrame(()=>editorRoot.current?.querySelector<HTMLButtonElement>('.gesso-export-tab-button')?.focus())};
  const chooseWorkspace=(group:typeof tab)=>{setPlaying(false);chooseGroup(group);setMenu(null)};
  useEffect(()=>{if(!showProductImport||tab!=='product'||layer!=='Model'){setProductFilename('');setProductSourceUnits('');}},[showProductImport,tab,layer]);
  const productWorkspace=tab==='product';
  const productModel=productWorkspace&&layer==='Model';
  const productDecals=productWorkspace&&layer==='Decals';
  const filmWorkspace=tab==='renders';
  const [filmTarget,setFilmTarget]=useState('$camera');
  const [filmMotionId,setFilmMotionId]=useState<string|null>(null);
  const [filmCurves,setFilmCurves]=useState(false);
  const [frameSetup,setFrameSetup]=useState<FrameSetup|null>(null);
  const [frameSetupError,setFrameSetupError]=useState('');
  const frameSetupBaseline=useRef<{history:typeof history;frame:number;target:string;layer:string;selected:string|null;space:'world'|'local'}|null>(null);
  const [filmLegacy,setFilmLegacy]=useState(false);
  const [sceneCreation,setSceneCreation]=useState<{step:'choose'|'static';shotId?:string}|null>(null);
  const staticImport=useRef<AbortController|null>(null);
  const sceneFocus=useRef<string|null>(null);
  const [importingFilmImage,setImportingFilmImage]=useState(false);
  const filmReturn=useRef<{frame:number;target:string}|null>(null);
  const animatorVisible=tab==='renders'&&mode==='video'&&layer==='Animation';
  const stillFilm=tab==='renders'&&mode==='still';
  const showComparison=!!renderScene?.comparison&&!productWorkspace&&(!filmWorkspace||showExport);
  const previewComparisonMode=showExport?'split':comparisonMode;
  const materialEditorVisible=!!scene&&productWorkspace&&layer==='Materials';
  const [worldObjectId,setWorldObjectId]=useState<string|null>(null);
  const stageObjectId=worldObjectId??(scene&&scene.environment.plinth.visible===false&&!scene.environment.props?.some((prop:any)=>prop.visible!==false)?'$product':null);
  const [stageTransformMode,setStageTransformMode]=useState<PropTransformEdit['mode']>('translate');
  useEffect(()=>setWorldObjectId(null),[project?.id,scene?.sceneId]);
  const worldEditorVisible=!!scene&&tab==='world'&&layer==='Props'&&!!worldObjectId&&[scene.environment.plinth,...(scene.environment.props??[])].some((item:any)=>item.id===worldObjectId);
  const sideEditorVisible=materialEditorVisible||worldEditorVisible;
  const filmGuidesVisible=filmWorkspace&&(!showComparison||showExport);
  const [filmGuide,setFilmGuide]=useState<FilmPresentationGuide|null>(null);
  useEffect(()=>{if(stillFilm)setPlaying(false)},[stillFilm]);
  const [sideEditorHost,setSideEditorHost]=useState<HTMLElement|null>(null);
  const [materialPreview,setMaterialPreview]=useState<MaterialPreview|null>(null);
  const [materialPreviewError,setMaterialPreviewError]=useState('');
  const [stillShowing,setStillShowing]=useState(false);
  const [nativeProofShowing,setNativeProofShowing]=useState(false);
  const [nativeProofInteracting,setNativeProofInteracting]=useState(false);
  const [stillViewVersion,setStillViewVersion]=useState(0);
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
  const decalImport=useRef<AbortController|null>(null);
  const selectedRef=useRef(selected);selectedRef.current=selected;
  useEffect(()=>()=>decalImport.current?.abort(),[]);
  const [parts,setParts]=useState<ViewportPart[]>([]);const [focused,setFocused]=useState(true);const [inspecting,setInspecting]=useState(false);const [hiddenParts,setHiddenParts]=useState<string[]>([]);
  const availableParts=useMemo(()=>{const removed=removedPartIds(scene);return (parts.length?parts:sceneParts(scene)).filter(part=>!removed.has(part.id));},[scene,parts]);
  useEffect(()=>{if(selected&&!availableParts.some(part=>part.id===selected))setSelected(availableParts[0]?.id??null);},[availableParts,selected]);
  const [sectionType,setSectionType]=useState('text');
  const [columnGuides,setColumnGuides]=useState(()=>{try{return localStorage.getItem('gesso.editor.column-guides')==='true'}catch{return false}});
  useEffect(()=>{try{localStorage.setItem('gesso.editor.column-guides',String(columnGuides))}catch{}},[columnGuides]);
  const editorRoot=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const root=editorRoot.current;if(!root)return;
    const toggle=(event:Event)=>{if(event.target instanceof HTMLDetailsElement)syncEditorDisclosureState(event.target)};
    root.addEventListener('toggle',toggle,true);
    return()=>root.removeEventListener('toggle',toggle,true);
  },[]);
  const [menu,setMenu]=useState<string|null>(null);const menuHost=useRef<HTMLDivElement>(null);
  const [presetMode,setPresetMode]=useState<'save'|'library'|null>(null);
  const presetContext=useRef({active,scene});presetContext.current={active,scene};
  useEffect(()=>{if(!active)setPresetMode(null);},[active]);
  useEffect(()=>{
    if(!randomPreview)return;
    const request=requestAnimationFrame(()=>editorRoot.current?.querySelector<HTMLButtonElement>('.gesso-export-setup-tabs [data-setup="random"]')?.focus());
    return()=>cancelAnimationFrame(request);
  },[randomPreview]);
  const chooseLayer=(name:string)=>{selectLayer(name);setMenu(null)};
  useEffect(()=>{setMenu(null)},[tab,layer]);
  const choosePart=(id:string)=>{setSelected(id);setFocused(true)};
  const [showTimeline,setShowTimeline]=useState<boolean|null>(null);
   const [showImport,setShowImport]=useState(false);const [importing,setImporting]=useState(false);
  const [imageUrl,setImageUrl]=useState('');const [preset,setPreset]=useState('botanical-studio');const [creditLimit,setCreditLimit]=useState(6000);const [remoteRuns,setRemoteRuns]=useState<any[]>([]);const [forceNew,setForceNew]=useState(false);
  const host=useRef<HTMLDivElement>(null);const hostB=useRef<HTMLDivElement>(null);const stageHost=useRef<HTMLDivElement>(null); const viewport=useRef<ReturnType<typeof createViewport>|null>(null);const viewportB=useRef<ReturnType<typeof createViewport>|null>(null); const newest=useRef(0); const sceneRef=useRef(scene);sceneRef.current=scene;
  const evaluatedScene=useRef<Scene|null>(null);const fullViewportInstalls=useRef(0);const frameRef=useRef(frame);frameRef.current=frame;const pickingRef=useRef(picking);pickingRef.current=picking;
  const pendingWorldFit=useRef<Scene|null>(null);
  const [productFitGuide,setProductFitGuide]=useState<{scene:Scene;frame:number;a:ProductFitRect;b?:ProductFitRect}|null>(null);
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
    if(preview&&!allowSceneEdit())return;
    previewOwner.current=materialPreviewScope;materialPreviewRef.current=preview;
    setMaterialPreview(preview);setMaterialPreviewError('');
    if(!preview && sceneRef.current!==evaluatedScene.current){
      // Save commits immediately, but the renderer receives that scene after evaluation.
      // Keep the matching preview visible until its committed replacement is ready.
      previewClearPending.current=true;++previewRequest.current;return;
    }
    previewClearPending.current=false;
    void sendMaterialPreview(preview,materialPreviewScope);
  },[materialPreviewScope,sendMaterialPreview,allowSceneEdit]);
  const flushMaterialPreviewClear=useCallback(()=>{
    if(!previewClearPending.current || materialPreviewRef.current)return Promise.resolve();
    previewClearPending.current=false;
    return sendMaterialPreview(null,currentPreviewScope.current);
  },[sendMaterialPreview]);
  useEffect(()=>{
    if(previewOwner.current!==materialPreviewScope)clearMaterialPreview();
  },[materialPreviewScope,clearMaterialPreview]);

  const previewTransform=useCallback((draft:Scene|null)=>{
    if(draft&&!allowSceneEdit())return;
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
  },[allowSceneEdit]);
  const updateTransformMode=useCallback((mode:TransformMode|null)=>{
    transformModeRef.current=mode;setTransformMode(mode);
  },[]);
  useEffect(()=>()=>{++transformRequest.current;transformAbort.current?.abort();if(transformTimer.current)clearTimeout(transformTimer.current);},[]);

  const pickHandler=useRef<(side:Side,point:any)=>void>(()=>{});
  const [worldName,setWorldName]=useState('Campaign room');const [owner,setOwner]=useState('');const [reuse,setReuse]=useState('');const [sourceUp,setSourceUp]=useState('Y');
  const file=useRef<HTMLInputElement>(null);const total=renderScene?sequenceEnd(renderScene):360;const fps=renderScene?.render.fps??24;
  const filmAudio=useFilmAudio(renderScene,{playing,frame,fps});
  const shot=renderScene?exactShotAtFrame(renderScene,frame):undefined;
  const filmEditShot=scene?exactShotAtFrame(scene,filmEditFrame):undefined;
  const filmSceneSelected=!!filmEditShot&&filmEditShot.kind!=='image';
  const filmSceneVisible=!!shot&&shot.kind!=='image';
  const setupShot=frameSetup?scene?.shots.find((item:any)=>item.id===frameSetup.shotId):null;
  const playbackStart=setupShot?.startFrame??1, playbackEnd=setupShot?.endFrame??total;
  loopPlaybackRef.current=loopPlayback&&filmWorkspace&&!showExport;
  const togglePlayback=()=>{if(frameRef.current>=playbackEnd||frameRef.current<playbackStart)setPlaybackFrame(playbackStart);setPlaying(value=>!value)};
  useEffect(()=>{if(!scene)return;const originalTotal=sequenceEnd(scene);if(filmEditFrame>originalTotal)setFrame(originalTotal);else if(frame>total)setPlaybackFrame(total);},[scene,total,filmEditFrame,frame,setFrame,setPlaybackFrame]);
  const dirty=!!scene&&!equalJson(scene,project?.scene);
  const currentCampaignOwner=():CampaignOwner|null=>{const current=projectRef.current,value=historyRef.current.present;return current&&value?{projectId:current.id,revisionId:current.revisionId,scene:value}:null;};
  const flushDraftRecovery=()=>{
    const current=projectRef.current,value=historyRef.current.present;
    if(!isStaticDemo&&current&&value&&!recoveryOpenRef.current)recoveryWriter.current?.queue(current,value);
    return recoveryWriter.current?.flush()??true;
  };
  useEffect(()=>{if(!isStaticDemo&&project&&scene&&!recoveryOpen)recoveryWriter.current?.queue(project,scene);},[project,scene,recoveryOpen]);
  useEffect(()=>{
    if(isStaticDemo)return;
    recoveryMounted.current=true;
    const flush=()=>{flushDraftRecovery();};
    const closing=(event:BeforeUnloadEvent)=>{
      const stored=flushDraftRecovery(),current=projectRef.current,value=historyRef.current.present;
      if(!stored&&current&&value&&!equalJson(value,current.scene)){event.preventDefault();event.returnValue='';}
    };
    const changed=(event:StorageEvent)=>{
      if(event.key&&!event.key.startsWith(DRAFT_PREFIX))return;
      const current=projectRef.current;if(!current)return;
      try{setRecoveryCandidates(readRecoveryDrafts(localStorage,current).filter(item=>!equalJson(item.scene,historyRef.current.present)));}catch{}
    };
    window.addEventListener('pagehide',flush);window.addEventListener('beforeunload',closing);window.addEventListener('storage',changed);
    return()=>{recoveryMounted.current=false;window.removeEventListener('pagehide',flush);window.removeEventListener('beforeunload',closing);window.removeEventListener('storage',changed);recoveryWriter.current?.dispose();importGuard.current.cancel();++recoveryGeneration.current;};
  },[]);
  const saveStatus=resolveSaveStatus({saving,loaded:!!project,busy:busy||productImporting||importing||importingFilmImage,dirty});
  const savePreview:SavePreview=materialPreview?'material':transformDraft?'transform':randomPreview&&exportDraft?'film':null;
  const valid=!!renderScene&&!!samples.length&&!evaluating&&!validationError&&evaluatedScene.current===renderScene;
  const visibleViewportLoading=productImporting||!validationError&&((viewportLoading.a&&(!showComparison||previewComparisonMode!=='b'))||(viewportLoading.b&&showComparison&&previewComparisonMode!=='a'));
  const controlsReady=valid||!!(renderScene&&evaluatedScene.current&&!validationError&&!visibleViewportLoading&&!renderScene.comparison&&fullViewportInstalls.current===0&&canUpdateViewportScene(evaluatedScene.current,renderScene));
  const postProcessingReady=!!renderScene&&samples.length>0&&!busy&&!visibleViewportLoading&&!validationError
    &&fullViewportInstalls.current===0&&isImageFinishOnlyChange(evaluatedScene.current,renderScene);
  const analyzePostProcessing=async()=>{
    const source=renderScene;
    if(!source||!viewport.current||!postProcessingReady)throw new Error('Wait for the current preview to load.');
    setPlaying(false);
    const analysis=await viewport.current.analyzeImageFinish();
    if(renderSceneRef.current!==source)throw new Error('The scene changed. Balance the new view again.');
    return analysis;
  };
  useEffect(() => {
    const report = () => {
      if (entranceReported.current) return;
      // The existing narrow-screen gate is a complete destination. Its hidden
      // canvases cannot present a frame until the editor has enough room.
      if (innerWidth < 900) {entranceReported.current=true;entranceCallbacks.current.onReady?.();return;}
      if (error || validationError) {entranceCallbacks.current.onLoadError?.(error || validationError); return;}
      if (valid && (presented.a || graphicsError.a) && (!showComparison || presented.b || graphicsError.b || graphicsError.a)) {
        entranceReported.current = true; entranceCallbacks.current.onReady?.();
      }
    };
    report();
    if (entranceReported.current) return;
    window.addEventListener('resize', report);
    return () => window.removeEventListener('resize', report);
  }, [valid, presented, showComparison, error, validationError, graphicsError]);
  const calibrationRef=useRef(calibrationDrafts);calibrationRef.current=calibrationDrafts;
  const calibrationKey=JSON.stringify(scene?.comparison?.calibration??{});
  const calibrationWorldKey=JSON.stringify([scene?.environment,scene?.comparison?.alternative].map(environment=>[environment?.asset?.sha256,environment?.asset?.sourceUp,environment?.revisionId]));
  useEffect(()=>{const saved=JSON.parse(calibrationKey);const draft=(side:Side):CalibrationDraft=>({floor:saved[side]?.sourceFloorPoint,points:saved[side]?.measurement?.sourcePoints??[],distance:saved[side]?.measurement?.realDistanceM?.toString()??'',yaw:''});setCalibrationDrafts({a:draft('a'),b:draft('b')});setPicking(null)},[calibrationKey,calibrationWorldKey,project?.id]);
  const change=(edit:(s:Scene)=>void)=>{if(!allowSceneEdit())return false;setPlaying(false);setPicking(null);setPickingSurface(false);setNotice('');setError('');return setHistory(previous=>{if(!previous.present)return previous;const next=clone(previous.present);edit(next);return commitHistory(previous,next)})};
  const resumeFilmEditing=()=>{setPlaying(false);restoreEditingFrame();};
  const changeFilm=(edit:(s:Scene)=>void)=>{if(!allowSceneEdit())return false;resumeFilmEditing();return change(edit);};
  const changeExport=(edit:(s:Scene)=>void)=>{
    if(!allowSceneEdit())return false;
    const current=exportContextRef.current;
    if(!current.showExport||current.tab!==exportSetupTab||current.scene!==scene||current.renderScene!==renderScene||current.projectId!==project?.id)
      throw new Error('The export setup changed. Try that edit again in the current preview.');
    setPlaying(false);
    if(randomPreview){setRandomDraft(editExportDraft(randomDraft,scene,project?.id??'',edit));}
    else return change(edit);
    return true;
  };
  const previewWorldCleanup=(preview:WorldCleanupPreview|null)=>{
    if(!preview){setCleanupOwner(null);setCleanupSelection(null);return true;}
    if(!scene||!project||!active||tab!=='world'||layer!=='Environment'||scene.comparison
      ||historyRef.current.present!==scene||projectRef.current?.id!==project.id||busy||saving
      ||transformModeRef.current||materialPreviewRef.current||!allowSceneEdit())return false;
    setPlaying(false);setPicking(null);setPickingSurface(false);
    setCleanupOwner(previous=>previous&&previous.source===scene&&previous.projectId===project.id&&previous.environment===preview.environment&&previous.label===preview.label?previous:{source:scene,projectId:project.id,...preview});return true;
  };
  const applyWorldCleanup=(environment:any)=>{
    if(!canApplyWorldCleanup(scene,project?.id??'',cleanupPreviewRef.current,environment)
      ||historyRef.current.present!==scene||busy||saving||!valid||visibleViewportLoading)return false;
    const applied=change(next=>{next.environment=clone(environment);});
    if(!applied)return false;
    setCleanupOwner(null);setCleanupSelection(null);setWorldObjectId(null);
    setNotice('Mesh copy applied · Undo to restore. Review world alignment and product contact before saving.','success');return true;
  };
  useEffect(()=>{viewport.current?.setWorldCleanupSelection(cleanupPreview?cleanupSelection:null);viewportB.current?.setWorldCleanupSelection(null);},[cleanupSelection,cleanupPreview]);
  const loadProject=(p:Project,{discardCurrentDraft=false}:{discardCurrentDraft?:boolean}={})=>{
    if(discardCurrentDraft&&projectRef.current)recoveryWriter.current?.clear(projectRef.current.id);else flushDraftRecovery();
    closeProductImport();++recoveryGeneration.current;
    setImportDecision(null);setImportDecisionBusy(false);setImportDecisionError('');
    setRecoveryBusy(false);setRecoveryError('');setRecoveryRevisionId(p.revisionId);setRecoverySeparate(false);
    let recovered:RecoveryDraft[]=[];
    if(!isStaticDemo)try{recovered=readRecoveryDrafts(localStorage,p);}catch{setDraftStorageError('Local recovery could not be read. Save a revision before closing.');}
    setRecoveryCandidates(recovered);setRecoveryOpen(recovered.length>0);recoveryOpenRef.current=recovered.length>0;
    projectRef.current=p;setNativeProofInteracting(false);
    cancelSceneCreation();clearMaterialPreview();viewport.current?.resetFraming();viewportB.current?.resetFraming();try{localStorage.setItem('gesso.project',p.id)}catch{}setProject(p);const opened=clone(p.scene);let compacted=false,compactionError='';try{if(!isStaticDemo)compacted=closeSequenceGaps(opened)}catch(reason){compactionError=reason instanceof Error?reason.message:'Could not close film gaps.'}installHistory(compacted?commitHistory(createHistory(p.scene),opened):createHistory(p.scene));setFilmTarget('$camera');setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);setFrameSetup(null);frameSetupBaseline.current=null;setFrameSetupError('');filmReturn.current=null;setFrame(1);setPlaying(false);setPicking(null);setPickingSurface(false);setObjects(undefined);setError('');setValidationError('');setParts([]);setUvLayout(null);setSelectedDecalId(null);setSelected(p.scene.product.label?.componentId??p.scene.product.components[0]?.id??null);setFocused(true);setInspecting(false);setHiddenParts([]);setNotice(compacted?'Film gaps closed · Undo to restore':compactionError||'Project opened',compactionError&&!compacted?'error':'success')};
  const openRecoveryChoices=()=>{
    const current=projectRef.current;if(!current||isStaticDemo)return;
    if(transformModeRef.current||materialPreviewRef.current){setError('Apply or discard the current transform or material preview before opening recovery drafts.');return;}
    flushDraftRecovery();
    try{
      const choices=readRecoveryDrafts(localStorage,current).filter(item=>!equalJson(item.scene,historyRef.current.present));
      setRecoveryCandidates(choices);setRecoveryRevisionId(current.revisionId);setRecoverySeparate(!equalJson(historyRef.current.present,current.scene));setRecoveryError('');setRecoveryOpen(choices.length>0);
      if(!choices.length)setNotice('The current scene has no other recovery drafts.');
    }catch{setDraftStorageError('Local recovery could not be read. Save a revision before closing.');}
  };
  const discardRecovery=(draft:RecoveryDraft)=>{
    const current=projectRef.current;if(!current)return;
    try{
      const removed=removeRecoveryDraft(localStorage,draft),choices=readRecoveryDrafts(localStorage,current).filter(item=>!equalJson(item.scene,historyRef.current.present));
      setRecoveryCandidates(choices);setRecoveryError(removed?'':'This draft changed in another tab. Review its latest version before discarding.');
      if(!choices.length){setRecoveryOpen(false);setNotice('Local draft discarded. Saved revision unchanged.');}
    }catch{setRecoveryError('This draft could not be discarded. Your saved revision is unchanged.');}
  };
  const restoreRecovery=async(draft:RecoveryDraft)=>{
    const current=projectRef.current,source=historyRef.current.present;if(!current||recoveryBusy)return;
    const generation=++recoveryGeneration.current,asNew=recoverySeparate||draft.baseRevisionId!==recoveryRevisionId;
    const owned=()=>recoveryMounted.current&&generation===recoveryGeneration.current&&projectRef.current?.id===current.id&&historyRef.current.present===source;
    const assertDraftCurrent=()=>{if(!recoveryDraftIsCurrent(localStorage,draft)){setRecoveryCandidates(readRecoveryDrafts(localStorage,current));throw new RecoveryDraftChangedError();}};
    setRecoveryBusy(true);setRecoveryError('');
    try{
      assertDraftCurrent();
      const latest:Project=await api(`/api/projects/${current.id}`);
      if(!owned())return;
      assertDraftCurrent();
      if(!asNew&&latest.revisionId!==draft.baseRevisionId){setRecoveryRevisionId(latest.revisionId);throw new Error('The saved revision changed. Choose Restore as new campaign to preserve both versions.');}
      await api('/api/evaluate','POST',{scene:draft.scene,frame:1});
      if(!owned())return;
      assertDraftCurrent();
      if(asNew){
        const restored:Project=await api('/api/projects','POST',{name:`${current.name.slice(0,98)} · recovered draft`,scene:draft.scene});
        if(!owned())return;
        assertDraftCurrent();
        removeRecoveryDraft(localStorage,draft);loadProject(restored);setRecoveryOpen(false);setProjects(await api('/api/projects'));setNotice('Recovered draft opened as a separate campaign. Original saved revision preserved.','success');
      }else{
        try{handoffRecoveryDraft(localStorage,recoveryWriterId,latest,draft);}
        catch(reason){
          if(reason instanceof RecoveryDraftChangedError)throw reason;
          setDraftStorageError('The original recovery draft is safe, but a new local copy could not be stored.');
          throw new Error('The original draft is still stored. Download it or free local recovery storage before retrying.');
        }
        loadProject(latest);setRecoveryOpen(false);recoveryOpenRef.current=false;
        installHistory(commitHistory(createHistory(latest.scene),draft.scene));setSelected(draft.scene.product.label?.componentId??draft.scene.product.components[0]?.id??null);setNotice('Local draft restored. Save a revision to keep it.','success');
      }
    }catch(reason){if(owned())setRecoveryError(reason instanceof Error?reason.message:'The draft could not be restored.');}
    finally{if(owned())setRecoveryBusy(false);}
  };
  useEffect(()=>{const abort=new AbortController();api('/api/bootstrap','GET',undefined,abort.signal).then(async b=>{let remembered:string|null=null;try{remembered=localStorage.getItem('gesso.project')}catch{}let opened=b.project;const initialId=startupProjectId(b.projects,opened.id,remembered);if(initialId!==opened.id){try{opened=await api(`/api/projects/${initialId}`,'GET',undefined,abort.signal)}catch{}}if(abort.signal.aborted)return;loadProject(opened);setProjects(b.projects);setWorlds(b.worlds);setCaps(b.capabilities);setJobs(b.jobs)}).catch(e=>{if(!abort.signal.aborted)setError(e.message)});return()=>abort.abort()},[]);
  useEffect(()=>{
    if(!host.current)return;
    let view:ReturnType<typeof createViewport>;
    try{
      view=createViewport(host.current,{studioMode:true,onWorldCleanupError:message=>setNotice(message,'error'),onPresented:()=>setPresented(value=>({...value,a:true})),onLoading:loading=>setViewportLoading(value=>({...value,a:loading})),onFilmGuide:setFilmGuide,onInteract:()=>{setNativeProofInteracting(true);setPlaying(false);setInspecting(true);setStillViewVersion(value=>value+1)},onInteractEnd:()=>{setNativeProofInteracting(false);setStillViewVersion(value=>value+1)},onParts:setParts,onError:setValidationError,onWorldPoint:point=>pickHandler.current('a',point),onSurfacePoint:point=>surfacePickHandler.current('a',point)});
    }catch(error){
      setGraphicsError(previous=>({...previous,a:error instanceof Error?error.message:String(error)}));
      return;
    }
    viewport.current=view;
    setGraphicsError(previous=>({...previous,a:''}));
    return()=>{++previewRequest.current;currentPreviewScope.current=null;view.dispose();viewport.current=null;};
  },[]);
  const needsComparisonViewport=!!renderScene?.comparison;
  useEffect(()=>{
    if(!needsComparisonViewport||!hostB.current||!viewport.current)return;
    let second:ReturnType<typeof createViewport>;
    try{
      second=createViewport(hostB.current,{studioMode:true,onPresented:()=>setPresented(value=>({...value,b:true})),onLoading:loading=>setViewportLoading(value=>({...value,b:loading})),onInteract:()=>{setNativeProofInteracting(true);setPlaying(false);setInspecting(true);setStillViewVersion(value=>value+1)},onInteractEnd:()=>{setNativeProofInteracting(false);setStillViewVersion(value=>value+1)},onError:message=>{if(renderSceneRef.current?.comparison)setValidationError(message)},onWorldPoint:point=>pickHandler.current('b',point),onSurfacePoint:point=>surfacePickHandler.current('b',point)});
    }catch(error){
      setGraphicsError(previous=>({...previous,b:error instanceof Error?error.message:String(error)}));
      return;
    }
    viewportB.current=second;
    setGraphicsError(previous=>({...previous,b:''}));
    return()=>{second.dispose();viewportB.current=null;setPresented(value=>({...value,b:false}));};
  },[needsComparisonViewport]);
  useEffect(()=>{const scene=renderScene;if(!scene)return;const request=++newest.current;const abort=new AbortController();
    const finishOnly=fullViewportInstalls.current===0&&isImageFinishOnlyChange(evaluatedScene.current,scene)&&samples.length>0;
    const reuseSamples=!scene.comparison&&fullViewportInstalls.current===0&&samplesRef.current.length>0&&canReuseViewportSamples(evaluatedScene.current,scene)&&canUpdateViewportScene(evaluatedScene.current,scene);
    if(finishOnly){viewport.current?.setImageFinish(scene.postProcessing);viewportB.current?.setImageFinish(scene.postProcessing);}
    if(!scene.comparison&&(finishOnly||reuseSamples)){
      // Surface/light values do not alter poses. Update retained GPU resources in
      // the input turn; authoritative validation still owns readiness/export.
      const sample=samplesRef.current[frameRef.current-1];
      if(sample)void viewport.current?.setScene(scene,sample).catch(error=>{if(request===newest.current)setValidationError(error.message);});
    }
    setEvaluating(true);setValidationError('');const timer=setTimeout(()=>{
    if(finishOnly||reuseSamples){
      const sampledFrame=frameRef.current;
      api('/api/evaluate','POST',{scene,frame:sampledFrame},abort.signal).then(async result=>{
        if(request!==newest.current)return;
        if(!finishOnly||!scene.comparison){
          const sample=frameRef.current===sampledFrame?result.sample:samplesRef.current[frameRef.current-1];
          await viewport.current?.setScene(result.scene,sample);
          if(request!==newest.current)return;
        }
        await flushMaterialPreviewClear();
        if(request!==newest.current)return;
        evaluatedScene.current=scene;setDigest(result.digest);setSamples(previous=>[...previous]);setEvaluating(false);
      }).catch(error=>{if(request===newest.current){setValidationError(error.message);setEvaluating(false);}});
      return;
    }
    api('/api/evaluate','POST',{scene},abort.signal).then(async result=>{if(request!==newest.current)return;if(scene.comparison&&(!result.comparison?.a||!result.comparison?.b))throw new Error('Both environment scenes are required for comparison preview.');const sampled=result.frames[Math.min(frameRef.current-1,result.frames.length-1)];
      // An undo followed by grading must supersede any newer visual load still
      // installing assets; the evaluated source alone cannot prove what's drawn.
      fullViewportInstalls.current++;
      try {
      if(!result.comparison)viewportB.current?.clearScene();
      await Promise.all([viewport.current?.setScene(result.comparison?.a??result.scene,sampled),result.comparison?viewportB.current?.setScene(result.comparison.b,sampled):Promise.resolve()]);
      if(request!==newest.current)return;const currentFrame=Math.min(frameRef.current,result.frames.length);const currentSample=result.frames[currentFrame-1];
      await Promise.all([viewport.current?.setSample(currentSample),result.comparison?viewportB.current?.setSample(currentSample):Promise.resolve()]);
      await flushMaterialPreviewClear();
      if(request===newest.current){evaluatedScene.current=scene;transformCommitPending.current=false;setSamples(result.frames);setObjects(result.objects);setDigest(result.digest);setComparisonInfo(result.comparison??null);setPlaybackFrame(currentFrame);setValidationError('');setEvaluating(false)}
      } finally {fullViewportInstalls.current--;}
    }).catch(e=>{if(request===newest.current){setValidationError(e.message);setEvaluating(false)}})
  },180);return()=>{clearTimeout(timer);abort.abort();++newest.current}},[renderScene]);
  useEffect(()=>{viewport.current?.setFilmContent(filmWorkspace);viewportB.current?.setFilmContent(filmWorkspace)},[filmWorkspace,needsComparisonViewport]);
  useEffect(()=>{viewport.current?.setPlaybackActive(playing);viewportB.current?.setPlaybackActive(playing)},[playing,needsComparisonViewport]);
  useEffect(()=>{viewport.current?.setFilmGuides(filmGuidesVisible);viewportB.current?.setFilmGuides(showExport&&showComparison)},[filmGuidesVisible,showExport,showComparison,needsComparisonViewport]);
  useEffect(()=>{const sample=samples[frame-1];if(sample&&evaluatedScene.current===renderScene)void Promise.all([viewport.current?.setSample(sample),renderScene?.comparison?viewportB.current?.setSample(sample):Promise.resolve()]).catch(e=>setValidationError(e.message))},[samples,frame,renderScene]);
  useEffect(()=>{setUvLayout(selected?viewport.current?.getUvLayout(selected)??null:null)},[parts,selected]);
  useEffect(()=>{viewport.current?.setSelected(selected);viewportB.current?.setSelected(selected)},[selected,needsComparisonViewport]);
  useEffect(()=>{const part=productDecals?selected:null;viewport.current?.setUvProbePart(part);viewportB.current?.setUvProbePart(part)},[tab,layer,selected]);
  const hoverUv=useCallback((uv:[number,number]|null)=>{viewport.current?.setUvProbe(uv);viewportB.current?.setUvProbe(uv)},[]);
  const decalInteractionSurface=useCallback((element:HTMLDivElement|null)=>{viewport.current?.setInteractionSurface(element)},[]);
  useEffect(()=>{if(!scene)return;const all=parts.length?parts:sceneParts(scene);const {parents}=resolveHierarchy(scene,all);const members=all.filter(part=>{let id:string|null=part.id;const visited=new Set<string>();while(id&&!visited.has(id)){if(id===selected)return true;visited.add(id);id=parents[id]??null}return false}).map(part=>part.id);viewport.current?.setFocusParts(members);viewportB.current?.setFocusParts(members);const hidden=all.filter(part=>{let id:string|null=part.id;const visited=new Set<string>();while(id&&!visited.has(id)){if(hiddenParts.includes(id))return true;visited.add(id);id=parents[id]??null}return false}).map(part=>part.id);viewport.current?.setHiddenParts(showExport?[]:hidden);viewportB.current?.setHiddenParts(showExport?[]:hidden)},[parts,selected,scene,hiddenParts,showExport]);
  useEffect(()=>{const enabled=!showComparison&&!transformMode&&!showExport;viewport.current?.setInspectionEnabled(enabled);viewportB.current?.setInspectionEnabled(enabled);if(showComparison){viewport.current?.resetFraming();viewportB.current?.resetFraming();setInspecting(false)}},[showComparison,transformMode,showExport]);
  useEffect(()=>{viewport.current?.setProductPreview(productWorkspace);viewportB.current?.setProductPreview(productWorkspace);setPicking(null)},[productWorkspace,needsComparisonViewport]);
  useEffect(()=>{const enabled=focused&&(productModel||productDecals);viewport.current?.setPartFocus(enabled);viewportB.current?.setPartFocus(enabled)},[focused,tab,layer,animatorVisible]);
  useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(timer)},[notice]);
  useEffect(()=>{const outside=(e:PointerEvent)=>{if(!menuHost.current?.contains(e.target as Node))setMenu(null)};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside)},[]);
  useEffect(()=>{
    if(menu!=='File'||isStaticDemo)return;
    const abort=new AbortController();
    api('/api/projects','GET',undefined,abort.signal).then(value=>{if(!abort.signal.aborted)setProjects(value);}).catch(()=>{});
    return()=>abort.abort();
  },[menu]);
  useEffect(()=>{
    if(!active)return;
    const polling=startExportJobPolling({
      readJobs:signal=>api('/api/jobs','GET',undefined,signal),
      readPairs:signal=>api('/api/comparison-renders','GET',undefined,signal),
      onJobs:next=>setJobs(previous=>equalJson(previous,next)?previous:next),
      onPairs:next=>setPairJobs(previous=>equalJson(previous,next)?previous:next),
    });
    jobPolling.current=polling;
    return()=>{if(jobPolling.current===polling)jobPolling.current=null;polling();};
  },[active]);
  useEffect(()=>{viewport.current?.setWorldPickEnabled(picking?.side==='a');viewportB.current?.setWorldPickEnabled(picking?.side==='b')},[picking]);
  useEffect(()=>{viewport.current?.setSurfacePickEnabled(pickingSurface&&(!scene?.comparison||comparisonMode!=='b'));viewportB.current?.setSurfacePickEnabled(pickingSurface&&!!scene?.comparison&&comparisonMode!=='a')},[pickingSurface,comparisonMode,!!scene?.comparison]);
  useEffect(()=>{setPickingSurface(false)},[scene,tab]);
  useEffect(()=>{const hidden=()=>{if(document.hidden)setPlaying(false)};document.addEventListener('visibilitychange',hidden);
    const observer=new IntersectionObserver(entries=>{if(!entries[0]?.isIntersecting)setPlaying(false)});if(stageHost.current)observer.observe(stageHost.current);
    return()=>{document.removeEventListener('visibilitychange',hidden);observer.disconnect()}},[]);
  // While the soundtrack is audibly running it is the master clock; the frame clock only fills in before, after and while it buffers.
  useEffect(()=>{
    if(!playing)return;
    setPicking(null);setPickingSurface(false);
    let raf=0,start=performance.now(),first=frame,previous=frame;
    filmAudio.play((first-1)/fps);
    const tick=(time:number)=>{
      let next=first+Math.floor((time-start)/1000*fps);
      const heard=filmAudio.sync((next-1)/fps);
      if(heard!==null){next=Math.max(previous,1+Math.floor(heard*fps+1e-6));first=next;start=time}
      const resolved=resolveFilmPlaybackFrame(next,playbackStart,playbackEnd,loopPlaybackRef.current);
      previous=resolved.frame;
      if(resolved.wrapped){
        // Both clocks restart together; the selected editing scene stays unchanged.
        first=resolved.frame;start=time;filmAudio.play((resolved.frame-1)/fps);
      }
      setPlaybackFrame(resolved.frame);
      if(resolved.ended){setPlaying(false);return}
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(raf);filmAudio.pause()};
  },[playing,fps,playbackStart,playbackEnd,filmAudio]);
  useEffect(()=>{if(!active||stillShowing||exportReviewVisible)return;const key=(e:KeyboardEvent)=>{const target=e.target as HTMLElement;if(e.defaultPrevented||transformModeRef.current)return;if(e.isComposing||target?.closest('input,textarea,select')||target?.isContentEditable)return;
    const destination=shortcutDestination(e,tab,mode);if(destination){e.preventDefault();if(target?.closest('.timeline,.gesso-sidebar,.gesso-world-object-editor')){const selector=destination.group?`.gesso-navrow button[data-category="${destination.group}"]`:`.gesso-sidebar-layers button[data-layer="${destination.layer}"]`;editorRoot.current?.querySelector<HTMLButtonElement>(selector)?.focus({preventScroll:true})}if(destination.group)chooseWorkspace(destination.group);if(destination.layer)selectLayer(destination.layer);setMenu(null);return}
    if(sceneCreation){if(e.key==='Escape'){e.preventDefault();cancelSceneCreation()}return}
    const inView=!!target&&!!stageHost.current?.contains(target);
    const inTimeline=!!target?.closest('.timeline,.film-timeline-dock');
    if(showExport){if(e.key==='Escape'){e.preventDefault();closeExport()}else if(inView&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&e.code==='Space'&&!target?.closest('button,a')){e.preventDefault();if(valid&&mode==='video'&&!e.repeat)togglePlayback()}return}
    if(inView&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&e.code==='KeyF'){
      if(e.shiftKey&&filmWorkspace&&inspecting){e.preventDefault();resetView();}
      else if(!e.shiftKey&&tab==='world'&&layer==='Props'&&stageObjectId&&!scene?.environment.gaussianProtection){e.preventDefault();frameProp(stageObjectId);}
      else if(!e.shiftKey&&productWorkspace&&selected){e.preventDefault();framePart();}
      return;
    }
    if(e.key==='Escape'){setMenu(null);setPicking(null);setPickingSurface(false);return}
    if((e.metaKey||e.ctrlKey)&&e.code==='KeyS'){e.preventDefault();if(dirty&&!busy&&!evaluating)void save();return}
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo()}
    else if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo()}
    else if((inTimeline||inView&&filmWorkspace)&&!target?.closest('button,a')&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&e.code==='Space'){e.preventDefault();if(valid&&!stillFilm&&!e.repeat){togglePlayback()}}
    else if((inTimeline||inView&&filmWorkspace)&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();setPlaying(false);setFrame(f=>Math.max(1,Math.min(total,f+(e.key==='ArrowRight'?1:-1))))}};
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key)},[active,showExport,sceneCreation,stillShowing,exportReviewVisible,total,valid,tab,mode,stillFilm,dirty,busy,evaluating,scene,project,chooseGroup,selectLayer,playbackStart,playbackEnd,filmWorkspace,productWorkspace,inspecting,selected,layer,stageObjectId]);
  const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn()}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  const openCampaign=(id:string)=>{
    if(dirty||busy||id===project?.id)return;
    if(transformModeRef.current||materialPreviewRef.current){setError('Apply or discard the current transform or material preview before switching campaigns.');return;}
    closeProductImport();
    const current=sceneRef.current;
    void perform(async()=>{
      const opened=await api(`/api/projects/${id}`);
      if(sceneRef.current!==current)throw new Error('The current campaign changed while opening another. Save the revision before switching.');
      loadProject(opened);navigate('world','Environment');setShowTimeline(null);setMenu(null);
    });
  };
  const commitComparison=(next:Scene)=>{if(!allowSceneEdit())return false;setPlaying(false);setPicking(null);setPickingSurface(false);setError('');setNotice('');return setHistory(previous=>commitHistory(previous,next))};
  const presetBlocked=!!(isStaticDemo||!scene||busy||saving||productImporting||importDecisionBusy||recoveryBusy||!valid||transformMode||materialPreview||randomPreview||cleanupPreview);
  const presetReason=cleanupPreview?'Apply the cleanup preview or return to the original before using presets.':isStaticDemo?'Presets need a connected workspace.':randomPreview?'Keep or discard the generated film before saving or loading presets.':transformMode||materialPreview?'Apply or discard the current preview before using presets.':!valid?'Wait for the current setup to finish loading.':'';
  const openPreset=(mode:'save'|'library')=>{if(presetBlocked)return;setPlaying(false);setMenu(null);setPresetMode(mode);};
  const presetSource=()=>{const source=historyRef.current.present;if(!source||!presetContext.current.active)throw new Error('Open a campaign before using presets.');return source;};
  const listSetupPresets=async(signal:AbortSignal):Promise<PresetSummary[]>=>{
    const source=presetSource();const records=await api('/api/presets/query','POST',{scene:source},signal);
    if(signal.aborted||historyRef.current.present!==source)throw new DOMException('The setup changed. Reopen presets.','AbortError');
    return records;
  };
  const saveSetupPreset=async(name:string,scopes:PresetScope[],signal:AbortSignal)=>{
    const source=presetSource();await api('/api/presets','POST',{name,scopes,scene:source},signal);
    if(signal.aborted||!presetContext.current.active)return;
    setPresetMode(null);setNotice('Preset saved · open Presets to load its selected sections.','success');
  };
  const applySetupPreset=async(id:string,scopes:PresetScope[],signal:AbortSignal)=>{
    const source=presetSource();const result=await api(`/api/presets/${id}/apply`,'POST',{scene:source,scopes},signal);
    if(signal.aborted||!presetContext.current.active||historyRef.current.present!==source)throw new DOMException('The setup changed. Load the preset again.','AbortError');
    if(!allowSceneEdit())return;
    commitComparison(result.scene);
    if(scopes.includes('product')){setSelected(result.scene.product.label?.componentId??result.scene.product.components[0]?.id??null);setHiddenParts([]);setFilmTarget('$camera');setFocused(true);setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming();}
    if(scopes.includes('stage'))setWorldObjectId(null);
    setPresetMode(null);setNotice(`Loaded ${result.preset.name} · Undo to restore the previous setup.`,'success');
  };
  const editComparison=(edit:(current:Scene)=>Scene)=>{if(!allowSceneEdit())return;try{if(sceneRef.current)commitComparison(edit(sceneRef.current))}catch(e:any){setError(e.message)}};
  const startComparison=()=>{editComparison(current=>enableComparison(current,worlds));setComparisonMode('split')};
  const comparisonWorld=(side:Side,id:string)=>{const world=worlds.find(item=>item.id===id);if(world)editComparison(current=>setComparisonWorld(current,side,world))};
  const comparisonTransform=(side:Side,field:'scaleToMeters'|'translationM',value:number,axis?:number)=>editComparison(current=>updateWorldTransform(current,side,asset=>{if(field==='scaleToMeters')asset.scaleToMeters=value;else asset.translationM[axis!]=value}));
  const changeComparisonMode=(mode:ComparisonMode)=>{setComparisonMode(mode);if(mode!=='split'&&pickingRef.current&&pickingRef.current.side!==mode)setPicking(null)};
  const draftCalibration=(side:Side,patch:Partial<CalibrationDraft>)=>setCalibrationDrafts(previous=>({...previous,[side]:{...previous[side],...patch}}));
  const startPick=(side:Side,kind:'floor'|'measurement')=>{setPlaying(false);setComparisonMode(mode=>mode==='split'?'split':side);if(kind==='measurement')draftCalibration(side,{points:[]});setPicking({side,kind})};
  pickHandler.current=(side,point)=>{const request=pickingRef.current;if(!request||request.side!==side||!Array.isArray(point.sourcePoint)||point.sourcePoint.length!==3||!point.sourcePoint.every(Number.isFinite))return;const sourcePoint=point.sourcePoint as [number,number,number];if(request.kind==='floor'){draftCalibration(side,{floor:sourcePoint});setPicking(null)}else{const points=[...calibrationRef.current[side].points,sourcePoint].slice(0,2);draftCalibration(side,{points});if(points.length===2)setPicking(null)}};
  const applyCalibration=(side:Side)=>perform(async()=>{const current=sceneRef.current;if(!current?.comparison||!valid)throw new Error('Wait for both environment previews to load.');const draft=calibrationDrafts[side];const calibration:any={};if(draft.floor)calibration.sourceFloorPoint=draft.floor;if(draft.points.length){if(draft.points.length!==2||!Number.isFinite(Number(draft.distance))||Number(draft.distance)<=0)throw new Error('Pick two measurement points and enter their positive distance in meters.');calibration.measurement={sourcePoints:draft.points,realDistanceM:Number(draft.distance)}}if(draft.yaw!==''){if(!Number.isFinite(Number(draft.yaw)))throw new Error('Yaw must be a finite number.');calibration.yawDeltaDegrees=Number(draft.yaw)}if(!Object.keys(calibration).length)throw new Error('Choose a floor point, a known distance, or an additional yaw.');const result=await api('/api/comparison/calibrate','POST',{scene:current,side,calibration});if(sceneRef.current!==current)throw new Error('The scene changed while placement was being calculated. Apply it again to the current scene.');commitComparison(result.scene);setNotice(`Environment ${side.toUpperCase()} placement applied. Save a revision to keep it.`,'success')});
  const reviewComparison=()=>perform(async()=>{const current=sceneRef.current;if(!current?.comparison||!valid)throw new Error('Wait for both environment previews to load.');const result=await api('/api/comparison/review','POST',{scene:current});if(sceneRef.current!==current)throw new Error('The scene changed during review. Review the current placement again.');commitComparison(result.scene);setNotice('Placement review recorded. Save this revision to preserve it.','success')});
  const persistCurrentRevision=async()=>{
    finishFrameSetup();
    if(transformModeRef.current)throw new Error('Apply or cancel the transform before saving.');
    const current=projectRef.current,value=historyRef.current.present;
    if(!current||!value)throw new Error('Open a campaign before saving.');
    setSaving(true);
    try{
      const result:Project=await api(`/api/projects/${current.id}`,'PUT',{scene:value,expectedRevisionId:current.revisionId});
      if(projectRef.current?.id===current.id){
        projectRef.current=result;setProject(result);
        if(equalJson(historyRef.current.present,result.scene))recoveryWriter.current?.clear(result.id);
        else recoveryWriter.current?.queue(result,historyRef.current.present);
      }
      try{removeSavedRecoveryDrafts(localStorage,result);}catch{}
      setProjects(await api('/api/projects'));return result;
    }finally{setSaving(false);}
  };
  const save=()=>perform(async()=>{if(cleanupPreviewRef.current)throw new Error('Apply the cleanup preview or return to the original before saving.');await persistCurrentRevision();setNotice(savePreview?'Original campaign saved; preview not included':'Revision saved','success');});
  const approve=()=>perform(async()=>{if(!project||dirty)throw new Error('Save this revision before approving it.');const result=await api(`/api/projects/${project.id}/approve`,'POST',{expectedRevisionId:project.revisionId});setProject(result);setNotice('Approved revision preserved','success')});
  const restore=()=>perform(async()=>{if(!allowSceneEdit()||!project?.approvedRevisionId)return;const old=await api(`/api/projects/${project.id}/revisions/${project.approvedRevisionId}`);setHistory(h=>commitHistory(h,old.scene));setNotice('Approved scene restored as an editable draft','success')});
  const exportBlockedReason=cleanupPreview?'Apply the cleanup preview or return to the original before exporting.':randomPreview&&(!exportDraft||randomSettingsDirty)?'Generate setup to preview and export these choices.':transformMode?'Apply or cancel the transform before exporting.':materialPreview?'Save or discard the material preview before exporting.':validationError?validationError:!valid?'Wait for the current scene to finish loading.':'';
  const openExport=(nextMode:ExportMode=mode,setup:ExportSetupTab='current')=>{
    if(cleanupPreviewRef.current){setError('Apply the cleanup preview or return to the original before exporting.');return;}
    if(!scene||busy)return;
    if(transformModeRef.current){setTransformError('Apply or cancel the transform before exporting.');return;}
    if(materialPreviewRef.current){setMaterialPreviewError('Save or discard this material preview before exporting.');return;}
    finishFrameSetup();setPlaying(false);setPicking(null);setInspecting(false);setMenu(null);
    viewport.current?.resetFraming();viewportB.current?.resetFraming();
    if(!showExport){exportPlayhead.current={projectId:project?.id??'',frame};jobPolling.current?.refresh();}
    chooseExportSetup(setup);navigate('renders','Output',nextMode);
  };
  const submitExport=async(payload:ExportPayload):Promise<ExportJob>=>{
    if(cleanupPreviewRef.current)throw new Error('Apply the cleanup preview or return to the original before exporting.');
    if(transformModeRef.current)throw new Error('Apply or cancel the transform before exporting.');
    if(materialPreviewRef.current)throw new Error('Save or discard the material preview before exporting.');
    if(randomPreview&&(!exportDraft||randomSettingsDirty))throw new Error('Generate setup before exporting.');
    if(!valid||!renderScene||renderScene!==renderSceneRef.current||evaluatedScene.current!==renderScene)throw new Error('Wait for the current scene and comparison previews to load.');
    const unavailable=exportBlockReason(caps,payload.format);if(unavailable)throw new Error(unavailable);
    setBusy(true);
    try{
      const paired=!!renderScene.comparison;
      const job=await api(paired?'/api/comparison-renders':'/api/renders','POST',{scene:renderScene,...payload});
      jobPolling.current?.refresh();
      if(paired){setPairJobs(previous=>[job,...previous.filter(item=>item.id!==job.id)]);return normalizePairExportJob(job);}
      setJobs(previous=>[job,...previous.filter(item=>item.id!==job.id)]);return job;
    }finally{setBusy(false);}
  };
  const controlExport=async(id:string,action:'cancel'|'resume',paired=false)=>{
    const job=await api(`${paired?'/api/comparison-renders':'/api/jobs'}/${id}/${action}`,'POST');
    if(paired)setPairJobs(previous=>[job,...previous.filter(item=>item.id!==job.id)]);
    else setJobs(previous=>[job,...previous.filter(item=>item.id!==job.id)]);
    jobPolling.current?.refresh();
  };
  useEffect(()=>{
    if (active) return;
    setPlaying(false);setPicking(null);setMenu(null);
  },[active]);
  useEffect(()=>{if(!showExport)return;setPlaying(false);setInspecting(false);setPicking(null);viewport.current?.resetFraming();viewportB.current?.resetFraming()},[showExport]);
  const fitProduct=()=>perform(async()=>{
    if(isStaticDemo)throw new Error('Fitting the product requires the local server. The browser demo preserves the saved product and camera positions.');
    const current=sceneRef.current, atFrame=frameRef.current, view=viewport.current;
    if(!current||!view||!valid||visibleViewportLoading)throw new Error('Wait for the product and world to finish loading.');
    setPlaying(false);setPicking(null);
    const result=await api('/api/evaluate','POST',{scene:current,frame:atFrame,includePlacement:true});
    if(sceneRef.current!==current||frameRef.current!==atFrame)throw new Error('The scene changed. Fit the product again in the current shot.');
    const views=[view,...(current.comparison&&viewportB.current?[viewportB.current]:[])];
    // Sample the exact frame used by export before measuring the live geometry.
    await Promise.all(views.map(item=>item.setSample(result.sample)));
    if(sceneRef.current!==current||frameRef.current!==atFrame)throw new Error('The scene changed. Fit the product again in the current shot.');
    const fits=views.map(item=>item.fitProductInWorld(result.sample,current.render.width/current.render.height));
    const next=applyProductWorldFit(current,Math.min(...fits.map(fit=>fit.multiplier)));
    setHistory(previous=>commitHistory(previous,next));
    const committed=historyRef.current.present;
    views.forEach(item=>item.resetFraming());setInspecting(false);setStillViewVersion(value=>value+1);
    setProductFitGuide({scene:committed,frame:atFrame,a:fits[0].targetRect,b:fits[1]?.targetRect});
    setNotice(`Product fitted · ${formatScalePercent(next.placement.scale ?? 1)}% of source size · Undo to restore`,'success');
  });
  const replaceWorld=(id:string,library=worlds)=>{
    if(!allowSceneEdit())return;
    pendingWorldFit.current=null;
    const selectedWorld=library.find(world=>world.id===id);
    const providerId=scene?.environment.provenance?.providerWorldId;
    const sameProviderWorld=typeof providerId==='string'&&!!providerId.trim()&&selectedWorld?.environment.provenance?.providerWorldId===providerId;
    let movedCamera=false;
    change(s=>{
      // A picked world contact belongs to its mesh; elsewhere the product returns to the floor.
      const leaveSurface=()=>{if(s.placement.restsOn!=='world-surface')return;s.placement.restsOn='floor';delete s.placement.contactPointM;s.placement.translationM=[0,0,0]};
      if(id==='authored'){const e=clone(s.environment);delete e.asset;delete e.previewAsset;delete e.fixture;delete e.collider;delete e.gaussianProtection;leaveSurface();e.kind='authored';e.revisionId='neutral-studio-v1';e.displayName='Authored studio';e.provenance={source:'Original authored studio',owner:'3d-product-suite',reuseBasis:'Original project geometry',allowedExternalDestinations:[]};s.environment=e;return}
      const world=library.find(w=>w.id===id);if(!world)return;
      const e=clone(world.environment);
      const protection=world.cameraProtection;
      if(protection){
        const {bounds,referenceCamera}=protection;
        e.gaussianProtection=clone(bounds);
        const within=(point:number[],min:number[],max:number[])=>point.every((value,index)=>value>=min[index]&&value<=max[index]);
        for(const shot of s.shots){
          if(shot.kind==='image')continue;
          for(const endpoint of ['from','to'] as const){
            const pose=shot.camera[endpoint];
            if(!within(pose.positionM,bounds.positionMinM,bounds.positionMaxM)||!within(pose.targetM,bounds.targetMinM,bounds.targetMaxM)){
              shot.camera[endpoint]={...pose,...clone(referenceCamera)};
              movedCamera=true;
            }
          }
        }
      }
      if(s.environment.studioSizeM!==undefined)e.studioSizeM=s.environment.studioSizeM;e.plinth=clone(s.environment.plinth);if(s.environment.floorY!==undefined)e.floorY=s.environment.floorY;else delete e.floorY;if(s.environment.props)e.props=clone(s.environment.props);if(e.kind!=='mesh')leaveSurface();s.environment=e;
    });
    // Published samples already contain the product/camera poses; fitting here
    // would invalidate the film after an otherwise supported world selection.
    // A representation comparison keeps the product fixed. Native sources
    // without collider geometry cannot support the automatic world fit.
    if(movedCamera)setNotice("Out-of-bounds shot framing moved to the reviewed camera · Undo to restore");
    const selectedEnvironment=selectedWorld?.environment;
    const canFit=selectedEnvironment?.kind==='mesh'||selectedEnvironment?.kind==='splat'&&!!selectedEnvironment.collider;
    if(!isStaticDemo&&id!=='authored'&&!sameProviderWorld&&canFit)pendingWorldFit.current=historyRef.current.present;
  };
  useEffect(()=>{
    const pending=pendingWorldFit.current;
    if(!pending)return;
    if(pending!==scene||tab!=='world'){pendingWorldFit.current=null;return;}
    if(!valid||visibleViewportLoading||busy)return;
    pendingWorldFit.current=null;
    void fitProduct();
  },[scene,tab,valid,visibleViewportLoading,busy]);
  const useAtlasWorld=async(id:string)=>{const library:World[]=await api('/api/worlds');if(!library.some(world=>world.id===id))throw new Error('The Atlas world is not available in this workspace');setWorlds(library);replaceWorld(id,library);};
  const importFile=async()=>{if(!allowSceneEdit())return;const chosen=file.current?.files?.[0];if(!chosen)return;setImporting(true);setError('');try{const q=new URLSearchParams({name:worldName,owner,reuseBasis:reuse,sourceUp});const result=await fetch(`/api/worlds/import?${q}`,{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':chosen.name},body:chosen});const data=await result.json();if(!result.ok)throw new Error(data.error);setWorlds(await api('/api/worlds'));setShowImport(false);setNotice(`${data.name} imported; review its alignment before rendering`)}catch(e:any){setError(e.message)}finally{setImporting(false)}};
  const runProductImport=async(choice:ProductImportChoice,discardPrevious:boolean)=>{
    const owner=currentCampaignOwner();
    if(!owner||!sameCampaignOwner(owner,choice.campaign))throw new Error('The campaign changed. Review the current scene before importing.');
    const request=importGuard.current.begin(owner);importRequest.current=request;
    setProductImporting(true);setImportDecision(null);setImportDecisionError('');setError('');
    try{
      const q=new URLSearchParams({name:choice.name,owner:choice.owner,reuseBasis:choice.reuseBasis,source:choice.source,...choice.settings});
      const result=await fetch(`/api/products/import?${q}`,{method:'POST',signal:request.controller.signal,headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':choice.file.name},body:choice.file});
      const data=await result.json();if(!result.ok)throw new Error(data.error);
      if(!recoveryMounted.current||request.controller.signal.aborted)return;
      const current=currentCampaignOwner();
      if(!current||!importGuard.current.accepts(request,current)||materialPreviewRef.current||transformModeRef.current||frameSetupBaseline.current){
        const available=await api('/api/projects');
        if(recoveryMounted.current&&!request.controller.signal.aborted){setProjects(available);setNotice('Import completed as a separate campaign. Your newer edits stay open. Find the import in File → Campaign.');}
        return;
      }
      if(discardPrevious)recoveryWriter.current?.clear(owner.projectId);
      importGuard.current.finish(request);importRequest.current=null;setProductImporting(false);
      loadProject(data,{discardCurrentDraft:discardPrevious});setProjects(await api('/api/projects'));setShowProductImport(false);
      setNotice(productImportNotice(choice.file.name,data.scene?.product?.metadata));
    }catch(reason){
      if(recoveryMounted.current&&!request.controller.signal.aborted&&importRequest.current===request)setError(reason instanceof Error?reason.message:'The product could not be imported.');
    }finally{
      if(importRequest.current===request){importGuard.current.finish(request);importRequest.current=null;if(recoveryMounted.current)setProductImporting(false);}
    }
  };
  const importProduct=async()=>{
    const chosen=productFile.current?.files?.[0];if(!chosen||productImporting)return;
    if(isStaticDemo){setError('Product imports require a connected backend.');return;}
    if(transformModeRef.current||materialPreviewRef.current){setError('Apply or discard the current transform or material preview before importing.');return;}
    finishFrameSetup();
    const campaign=currentCampaignOwner();if(!campaign)return;
    try{
      const choice:ProductImportChoice={file:chosen,name:productName,owner:productOwner,reuseBasis:productReuse,source:productSource,
        settings:productImportSettings(chosen.name,productSourceUp,productSourceUnits),campaign};
      if(!equalJson(campaign.scene,projectRef.current?.scene)){flushDraftRecovery();setImportDecisionError('');setImportDecision(choice);return;}
      await runProductImport(choice,false);
    }catch(reason){setError(reason instanceof Error?reason.message:'The product could not be imported.');}
  };
  const resolveImportDecision=async(saveFirst:boolean)=>{
    const choice=importDecision,owner=currentCampaignOwner();if(!choice||!owner||importDecisionBusy)return;
    if(!sameCampaignOwner(owner,choice.campaign)){setImportDecisionError('The campaign changed. Cancel and review the current scene before importing.');return;}
    setImportDecisionBusy(true);setImportDecisionError('');
    try{
      if(saveFirst){
        await persistCurrentRevision();
        const current=currentCampaignOwner();
        if(!current||current.projectId!==owner.projectId||current.scene!==owner.scene)throw new Error('The scene changed while saving. Review it before importing.');
        await runProductImport({...choice,campaign:current},false);
      }else await runProductImport(choice,true);
    }catch(reason){setImportDecisionError(reason instanceof Error?reason.message:'The current revision could not be saved.');}
    finally{setImportDecisionBusy(false);}
  };
  const generate=()=>perform(async()=>{const result=await api('/api/github-worlds/generate','POST',{imageUrl,preset,budgetCredits:creditLimit,forceNew});setForceNew(false);if(result.cacheStatus==='local-hit'){setWorlds(await api('/api/worlds'));setNotice('Reused the saved World Labs world and both meshes. No generation credits spent. Choose them in the world library.','success');return}setNotice(result.cacheStatus==='reused-request'?'A matching generation already exists. No new run submitted. Refresh runs to import its meshes when ready.':`World comparison submitted to GitHub Actions. Experiment ${String(result.id??'').slice(0,8)}. Saved results are checked before generating. Both final alternatives will be meshes.`);setRemoteRuns(await api('/api/github-worlds/runs'))});
  // Scene objects: reframe shots around the product and visible objects; place the product on a picked mesh surface (D160).
  const frameObjects=()=>perform(async()=>{const current=sceneRef.current;if(!current)return;const result=await api('/api/scene-objects/frame','POST',{scene:current});if(sceneRef.current!==current)throw new Error('The scene changed while framing. Try again.');commitComparison(result.scene);setNotice('Cameras framed around the product and visible objects. Save to keep this framing.','success')});
  const startSurfacePick=()=>{if(!valid||scene?.environment.kind!=='mesh'||!allowSceneEdit())return;setPlaying(false);setPicking(null);setPickingSurface(true);setError('');setNotice('Pick an upward-facing surface in the world.')};
  surfacePickHandler.current=(side,point)=>{if(!surfacePickRef.current||!point.worldPoint?.every(Number.isFinite))return;surfacePickRef.current=false;setPickingSurface(false);void perform(async()=>{const current=sceneRef.current;if(!current||current.environment.kind!=='mesh')return;const next=clone(current);next.placement.restsOn='world-surface';next.placement.contactPointM=[...point.worldPoint];next.placement.translationM=[0,0,0];const result=await api('/api/scene-objects/frame','POST',{scene:next});if(sceneRef.current!==current)throw new Error('The scene changed during placement. Pick the surface again.');commitComparison(result.scene);setNotice(current.comparison?`Product placed on the picked surface in view ${side.toUpperCase()}. Check contact in both views.`:'Product placed on the world surface. Cameras reframed around it.','success')})};
  const refreshRuns=()=>perform(async()=>{setRemoteRuns(await api('/api/github-worlds/runs'))});
  const importRun=(id:number)=>perform(async()=>{await api(`/api/github-worlds/runs/${id}/import`,'POST');setWorlds(await api('/api/worlds'));setNotice('World Labs mesh, Gaussian-derived mesh, and native splat imported. Review alignment before approval.')});
  const labels=renderScene?comparisonLabels(renderScene):{a:'Environment A',b:'Environment B'};
  const groupName=groups.find(item=>item.id===tab)!.label;
  const toggleVisibility=(id:string)=>setHiddenParts(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  const framePart=()=>{setStillViewVersion(value=>value+1);setPlaying(false);setInspecting(true);viewport.current?.frameSelection();viewportB.current?.frameSelection()};
  const stageProduct=stageObjectId==='$product';
  const stagePlinth=worldEditorVisible&&scene?.environment.plinth.id===worldObjectId;
  const stageProp=worldEditorVisible?(stagePlinth?scene.environment.plinth:scene.environment.props?.find((prop:any)=>prop.id===worldObjectId)):undefined;
  const stageActive=active&&tab==='world'&&layer==='Props'&&!graphicsError.a&&!scene?.comparison;
  const stageObjectVisible=!!(stageActive&&(stageProduct||stageProp&&stageProp.visible!==false));
  const stageToolsEnabled=stageObjectVisible&&!isStaticDemo;
  const stageMoveLocked=!!stageProp?.relationship;
  const activeStageMode=stagePlinth?'scale':stageMoveLocked&&stageTransformMode==='translate'?'rotate':stageTransformMode;
  const stageInteractive=stageActive&&valid&&!busy&&!playing&&!showExport&&!stillShowing&&!nativeProofShowing&&!cleanupPreview&&!transformMode&&!materialPreview&&!pickingSurface;
  const stageTarget=stageToolsEnabled&&stageInteractive?stageObjectId:null;
  const commitStageTransform=useRef<(edit:PropTransformEdit)=>boolean>(()=>false);
  commitStageTransform.current=(edit)=>{
    if(edit.id!==stageTarget||edit.mode!==activeStageMode)return false;
    if(edit.target==='product') return change(next=>{
      const placement=next.placement;
      if(edit.mode==='translate')placement.translationM=placement.translationM.map((offset:number,axis:number)=>offset+edit.deltaM[axis]);
      else if(edit.mode==='rotate')placement.rotationYDegrees=((placement.rotationYDegrees??0)+edit.deltaYawDegrees)%360;
      else placement.scale=Math.min(PRODUCT_SCALE_MAX,Math.max(PRODUCT_SCALE_MIN,(placement.scale??1)*edit.scaleFactor));
    });
    const current=historyRef.current.present;
    const prop=stagePlinth?current?.environment.plinth:current?.environment.props?.find((item:any)=>item.id===edit.id);
    if(!prop||prop.id!==edit.id||prop.visible===false||edit.mode==='translate'&&prop.relationship)return false;
    if(edit.mode==='rotate'&&current.placement.restsOn===edit.id&&!canPropSupportProduct({...prop,rotationXyzw:edit.rotationXyzw}))return false;
    return change(next=>{
      const target=stagePlinth?next.environment.plinth:next.environment.props.find((item:any)=>item.id===edit.id);
      if(edit.mode==='translate')target.translationM=[...edit.translationM];
      else if(edit.mode==='rotate')target.rotationXyzw=[...edit.rotationXyzw];
      else edit.sizeM.forEach((size,axis)=>resizeProp(target,axis,size));
    });
  };
  useEffect(()=>{
    const view=viewport.current;
    view?.setPropTransform(stageTarget,activeStageMode,edit=>commitStageTransform.current(edit));
    return ()=>view?.setPropTransform(null,'translate');
  },[stageTarget,activeStageMode]);
  useEffect(()=>{
    const view=viewport.current;
    view?.setStagePropPicking(stageInteractive?setWorldObjectId:undefined);
    return ()=>view?.setStagePropPicking();
  },[stageInteractive]);
  const frameProp=(id:string)=>{setStillViewVersion(value=>value+1);setPlaying(false);setInspecting(true);viewport.current?.frameWorldObject(id);viewportB.current?.frameWorldObject(id)};
  const resetView=()=>{setStillViewVersion(value=>value+1);setInspecting(false);viewport.current?.resetFraming();viewportB.current?.resetFraming()};
  const undo=()=>{if(cleanupPreviewRef.current||randomPreview||!allowSceneEdit())return;if(frameSetupBaseline.current){discardFrameSetup(true);return;}setPlaying(false);setPicking(null);setHistory(undoHistory)};
  const redo=()=>{if(cleanupPreviewRef.current||randomPreview||!allowSceneEdit())return;finishFrameSetup();setPlaying(false);setPicking(null);setHistory(redoHistory)};
  const timelineVisible=!showExport&&(filmWorkspace&&!stillFilm||(!stillFilm&&!(productDecals)&&(showTimeline??tab==='renders')));
  const invalidateFrame=useFrameInvalidation();
  const studioFrameStyle=useRef({ground:'#080808',radius:20});
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
    studioFrameStyle.current={ground:styles.getPropertyValue('--chrome').trim()||'#080808',
      radius:parseFloat(styles.getPropertyValue('--gesso-radius-viewport'))||20};
    invalidateFrame('studio');
  },[active,sideEditorVisible,filmWorkspace,timelineVisible,animatorVisible,filmCurves,filmLegacy,showComparison,comparisonMode,showExport,invalidateFrame]);
  const previewFrame=(next:number)=>{setPlaying(false);setFrame(next)};
  const previewExportFrame=(next:number)=>{setPlaying(false);setPlaybackFrame(next)};
  const filmCamera=useFilmCamera({scene,samples:valid?samples:[],frame:filmWorkspace?filmEditFrame:frame,mode,active:active&&filmSceneSelected&&filmGuidesVisible&&filmTarget==='$camera'&&layer!=='Output',enabled:active&&valid&&!playing&&!busy&&(!filmWorkspace||filmSceneSelected&&frame===filmEditFrame),guide:isCameraFilmGuide(filmGuide)?filmGuide:null,viewport,onBeforeEdit:allowSceneEdit,onChange:changeFilm,onFrame:previewFrame,onResetView:resetView});
  const activeDecal=decalForPart(scene,selected,selectedDecalId);
  const selectedPart=availableParts.find(part=>part.id===selected);
  const transformPart=selectedPart??availableParts[0];
  const transformTarget:TransformTarget|null=filmWorkspace&&filmTarget==='$camera'?null:positionSpace==='world'?{kind:'product'}:
    transformPart && partTargetIds(scene).includes(transformPart.id) ? {kind:'part',componentId:transformPart.id}:null;
  const startTransform=()=>{
    if(!allowSceneEdit())return false;
    transformSource.current=sceneRef.current;transformCommitPending.current=false;
    setPlaying(false);setPicking(null);setNotice('');setTransformError('');
    viewport.current?.freezeSelectionFraming();viewportB.current?.freezeSelectionFraming();
    navigate('renders','Animation');
  };
  const commitTransform=(edit:(next:Scene)=>void)=>{
    if(!allowSceneEdit())return false;
    if(transformSource.current!==sceneRef.current)return;
    transformCommitPending.current=true;return change(edit);
  };
  const addDecal=()=>{
    if(!allowSceneEdit())return;
    if(busy||decalImport.current||!scene||!selected||!selectedPart||!uvLayout||uvLayout.missingUv||!uvLayout.triangleCount)return;
    const source=scene, partId=selected, decal=newDecal(scene,selected,selectedPart.componentId,uvLayout);
    const abort=new AbortController();decalImport.current=abort;
    setNotice('Preparing label artwork…');
    void perform(async()=>{
      try {
        const prepared=await canonicalizeDecalArtwork(decal,abort.signal);
        if(abort.signal.aborted)return;
        if(sceneRef.current!==source||selectedRef.current!==partId)throw new Error('The selected part changed. Add the label again to place it on this part.');
        change(next=>{next.product.decals=[...(next.product.decals??[]),prepared]});
        setSelectedDecalId(prepared.id);setNotice('Label added','success');
      } catch(reason) {setNotice('');throw reason;} finally {if(decalImport.current===abort)decalImport.current=null;}
    });
  };
  const placeDecal=(centerUv:[number,number])=>{if(activeDecal)change(next=>{
    const target=next.product.decals?.find((item:ProductDecal)=>item.id===activeDecal.id);if(target)target.centerUv=centerUv;
  })};
  const captureCurrentWorld=useCallback(async(signal:AbortSignal)=>{const view=viewport.current;if(!view)throw new Error('World preview is unavailable.');return (await view.capturePreview(signal)).blob;},[]);
  const captureOutline=useCallback((ids:string[],signal:AbortSignal)=>viewport.current?.captureModelOutline(ids,signal)??Promise.reject(new Error('Product preview is unavailable.')),[]);
  const productPanel=scene?<ProductPanel captureOutline={captureOutline} outlineRevision={digest} outlineReady={!evaluating&&!viewportLoading.a&&!!parts.length} workspace={tab==='renders'?'animation':productModel?'product':'material'} key={`${project?.id ?? ''}:${scene.sceneId}`} onBeforeEdit={allowSceneEdit} onPreview={previewMaterial} onMaterialHover={hoverMaterial} editorHost={materialEditorVisible?sideEditorHost:null} positionSpace={positionSpace} onPositionSpace={setPositionSpace} transformMode={transformMode} scene={transformDraft??scene} partId={selected} parts={parts} layer={layer as ProductLayer} onSelect={choosePart} onChange={change} onLayer={name=>chooseLayer(name)} focused={focused} onToggleFocus={()=>setFocused(value=>!value)} onFrame={framePart} hiddenParts={hiddenParts} onToggleVisibility={toggleVisibility} onImport={()=>{if(showProductImport)closeProductImport(true);else setShowProductImport(true);}} onRemoved={name=>setNotice(`${name} removed · Undo to restore`,'success')} frame={frame} onPreviewFrame={previewFrame} decal={activeDecal} uvLayout={uvLayout} onAddDecal={addDecal} onSelectDecal={setSelectedDecalId}/>:null;
  const filmEntries=scene&&filmEditShot?listMotions(scene,filmEditShot.id):[];
  const filmTimelineRows=scene?timelineMotions(scene,filmTarget).length+legacyMotions(scene).filter(item=>item.target===filmTarget).length:0;
  const filmOwners=filmEntries.filter(entry=>entry.motion.enabled&&entry.motion.target===filmTarget);
  const filmCameraOwner=filmEntries.find(entry=>entry.motion.enabled&&entry.motion.target==='$camera');
  const filmCameraOwners=filmCameraOwner&&!isCameraHoldMotion(filmCameraOwner.motion)?[filmCameraOwner]:[];
  useEffect(()=>{if(!filmWorkspace)return;if(layer==='Framing'&&filmTarget!=='$camera'){setFilmTarget('$camera');setFilmMotionId(null);setFilmLegacy(false);}else if(layer==='Animation'&&filmTarget==='$camera'){setFilmTarget('$product');setPositionSpace('world');}else if(layer==='Sequence'){setFilmLegacy(false);setFilmCurves(false);}},[tab,layer]);
  const chooseFilmTarget=(id:string)=>{
    finishFrameSetup();resumeFilmEditing();setFilmTarget(id);setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);
    if(id==='$product')setPositionSpace('world');
    else if(id!=='$camera'&&!isLightTarget(id)){setPositionSpace('local');setSelected(id);}
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
    if(scene&&filmTarget[0]!=='$'&&!partTargetIds(scene).includes(filmTarget))setFilmTarget('$camera');
    if(scene&&isLightTarget(filmTarget)&&!availableMotionKinds(scene,filmTarget).length)setFilmTarget('$camera');
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
    if(!scene||!valid||busy||!allowSceneEdit())return;
    finishFrameSetup();resumeFilmEditing();
    try{
      const draft=clone(scene), setup=createFrameSetup(draft,shotAtFrame(scene,filmEditFrame)?.id);
      frameSetupBaseline.current={history:historyRef.current,frame:filmEditFrame,target:filmTarget,layer,selected,space:positionSpace};
      change(next=>{next.shots=draft.shots;next.render=draft.render});
      setFrameSetup(setup);setFrameSetupError('');setFilmTarget('$product');setPositionSpace('world');
      setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);
      setFrame(draft.shots.find((item:any)=>item.id===setup.shotId).startFrame);navigate('renders','Animation');resetView();
      sceneFocus.current='.frame-setup-stages>button';
    }catch(reason){setError(reason instanceof Error?reason.message:'Could not create this frame.');}
  }
  const editFrameSetup=(edit:(draft:Scene,setup:FrameSetup)=>FrameSetup)=>{
    if(!frameSetup||!scene||!valid||busy||!allowSceneEdit())return;
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
    selectedMotionId:mode==='still'?null:filmMotionId,onMotionSelect:chooseFilmMotion,mode,playing,loopPlayback,onLoopPlaybackChange:setLoopPlayback,
    onPlay:()=>{resetView();togglePlayback()},onCreateShot:beginSceneCreation,disabled:!!sceneCreation||showExport||!!transformMode||!controlsReady||busy||importingFilmImage,
    editCurves:filmCurves,onEditCurves:setFilmCurves,onResetView:resetView,
    onLegacyAnimation:()=>{resumeFilmEditing();setFilmLegacy(true);setFilmCurves(false);setFilmMotionId(null);navigate('renders','Animation');}};
  const editFilmMechanism=()=>{filmReturn.current={frame:filmEditFrame,target:filmTarget};if(!filmTarget.startsWith('$'))setSelected(filmTarget);navigate('product','Model');};
  const returnToFilm=()=>{const saved=filmReturn.current;filmReturn.current=null;if(saved){chooseFilmTarget(saved.target);previewFrame(saved.frame);}};
  const filmPoseContent=scene?(filmTarget==='$camera'?<>
    {filmCameraOwners.length>0&&<p className="film-owner-note">Position follows {labelFor(scene, filmCameraOwners[0].motion).toLowerCase()}.</p>}
    <fieldset className="film-camera-fields" disabled={busy||!controlsReady}><CameraPanel scene={scene} frame={filmEditFrame} mode={mode} embedded cameraEnd={filmCamera.end} onCameraEndChange={filmCamera.onEndChange} cameraMotionDriven={!!filmCameraOwners.length} cameraTargetId={filmCamera.targetId} onCameraTargetChange={filmCamera.onTargetChange} samples={valid?samples:[]} onChange={changeFilm} onFrame={previewFrame} onResetView={resetView}/></fieldset>
  </>:isLightTarget(filmTarget)?<FilmLightPose scene={scene} target={filmTarget} onChange={changeFilm} disabled={busy||!controlsReady||filmOwners.length>0}/>
  :<FilmPoseInspector scene={scene} frame={filmEditFrame} target={filmTarget} onChange={changeFilm} onMotionSelect={chooseFilmMotion} disabled={busy||!controlsReady}/> ):null;
  function cancelSceneCreation(returnToChoice=false){
    staticImport.current?.abort();staticImport.current=null;sceneFocus.current=null;setImportingFilmImage(false);
    setSceneCreation(current=>returnToChoice&&current&&!current.shotId?{step:'choose'}:null);
    if(sceneCreation&&(!returnToChoice||sceneCreation.shotId))requestAnimationFrame(()=>{const root=editorRoot.current;const trigger=sceneCreation.shotId?root?.querySelector<HTMLButtonElement>('[data-static-scene-edit]'):null;(trigger??root?.querySelector<HTMLButtonElement>('[data-new-scene-trigger]'))?.focus()});
  }
  function beginSceneCreation(){
    if(!scene||!valid||busy||transformMode||!allowSceneEdit())return;
    finishFrameSetup();resumeFilmEditing();setPlaying(false);setSceneCreation({step:'choose'});
  }
  const editStaticScene=(shotId:string)=>{
    if(!valid||busy||transformMode||!allowSceneEdit())return;
    setPlaying(false);setSceneCreation({step:'static',shotId});
  };
  const submitStaticScene=async(input:StaticSceneDraft)=>{
    if(!allowSceneEdit())return;
    const source=sceneRef.current;if(!source||!sceneCreation)return;
    const editingId=sceneCreation.shotId,afterId=shotAtFrame(source,filmEditFrame)?.id;
    staticImport.current?.abort();const controller=new AbortController();staticImport.current=controller;
    setPlaying(false);setImportingFilmImage(true);
    try{
      const payload=input.kind==='text'?await renderFilmTextCard(input.card,source.render.width,source.render.height):input.file;
      if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
      const filename=input.kind==='text'?'text-card.png':input.file.name;
      const response=await fetch('/api/film/images/import',{method:'POST',headers:{'X-Product-Suite':'1','Content-Type':'application/octet-stream','X-Asset-Filename':encodeURIComponent(filename)},body:payload,signal:controller.signal});
      const asset=await response.json();if(!response.ok)throw new Error(asset.error||'The scene could not be added.');
      if(controller.signal.aborted||staticImport.current!==controller)throw new DOMException('Cancelled','AbortError');
      if(sceneRef.current!==source)throw new Error('The film changed. Add this scene again to use the current version.');
      const draft=clone(source),id=applyStaticScene(draft,asset,{name:input.name,durationFrames:Math.max(1,Math.round(input.durationSeconds*source.render.fps)),textCard:input.kind==='text'?input.card:undefined},{shotId:editingId,afterId});
      change(next=>{next.shots=draft.shots;next.render=draft.render});
      setFrame(draft.shots.find((item:any)=>item.id===id).startFrame);setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false);
      setSceneCreation(null);setMode('video');navigate('renders','Sequence');resetView();
      setNotice(editingId?'Scene updated':input.kind==='text'?'Text scene added':'Image scene added','success');
      sceneFocus.current='[data-static-scene-edit]';
    }finally{if(staticImport.current===controller){staticImport.current=null;setImportingFilmImage(false);}}
  };
  const staticEditingShot=sceneCreation?.shotId?scene?.shots.find((item:any)=>item.id===sceneCreation.shotId):null;
  const filmClipProps={...filmProps,onEditContent:editStaticScene};
  useEffect(()=>{if(!active||!filmWorkspace||showExport||stillFilm)cancelSceneCreation()},[active,filmWorkspace,showExport,stillFilm]);
  useEffect(()=>()=>{staticImport.current?.abort()},[]);
  useEffect(()=>{const selector=sceneFocus.current;if(!selector||!valid||busy||importingFilmImage)return;const target=editorRoot.current?.querySelector<HTMLButtonElement>(selector);if(target&&!target.disabled){sceneFocus.current=null;target.focus({preventScroll:true})}});
  useEffect(()=>{if(!filmSceneSelected){setFilmMotionId(null);setFilmCurves(false);setFilmLegacy(false)}},[filmSceneSelected]);
  const stillScope=useMemo(()=>({}),[scene,frame,tab,layer,materialPreview,transformDraft,stillViewVersion,active,selected,focused,hiddenParts]);
  const stillScopeRef=useRef(stillScope);stillScopeRef.current=stillScope;
  const showStill=useCallback((showing:boolean)=>{
    setStillShowing(showing);if(showing)setPlaying(false);
  },[]);
  useEffect(()=>{
    const suspended=stillShowing||nativeProofShowing||exportReviewVisible;
    if(suspended)setPlaying(false);
    viewport.current?.setSuspended(suspended);viewportB.current?.setSuspended(suspended);
  },[stillShowing,nativeProofShowing,exportReviewVisible]);
  const stillBlocked=
    !active?'Open the editor to render.':graphicsError.a?'Browser snapshots need a live WebGL 2 preview.':nativeProofShowing?'Return to preview to capture a browser snapshot.':cleanupPreview?'Apply the cleanup preview or return to the original before rendering.':!valid||visibleViewportLoading?'Wait for the preview to load.':
    busy?'Wait for the current operation.':transformMode?'Apply or cancel the transform first.':
    materialPreviewError?'Wait for a valid material preview.':
    scene?.comparison?'Use Export for a comparison render.':
    filmWorkspace&&!filmSceneVisible?'Select a 3D scene to render.':'';
  const renderStill=async(signal:AbortSignal)=>{
    if(stillBlocked)throw new Error(stillBlocked);
    const source=sceneRef.current, view=viewport.current, renderFrame=frameRef.current, scope=stillScopeRef.current;
    const sample=samplesRef.current[renderFrame-1];
    if(!source||!view||!sample||evaluatedScene.current!==source)throw new Error('Wait for the preview to load.');
    const checkCurrent=()=>{
      if(signal.aborted||stillScopeRef.current!==scope||sceneRef.current!==source||frameRef.current!==renderFrame)
        throw new DOMException('The view changed. Render again from the current view.','AbortError');
    };
    checkCurrent();
    setPlaying(false);
    await view.setSample(sample);
    checkCurrent();
    const still=await view.captureStill(signal);
    checkCurrent();
    return still;
  };
  const nativeProofScope=useMemo(()=>crypto.randomUUID(),[renderScene,project?.id,frame,stillViewVersion,mode,active,filmGuidesVisible,filmWorkspace,showExport,productWorkspace]);
  const nativeProofScopeRef=useRef(nativeProofScope);nativeProofScopeRef.current=nativeProofScope;
  const nativeProofActive=active&&!productWorkspace&&!playing&&!stillShowing&&!exportReviewVisible&&!sceneCreation;
  const nativeProofReason=isStaticDemo||!caps.nativeProofAvailable?'Render proofs need a connected Cycles backend.':
    !nativeProofActive?'Pause a 3D view to render a proof.':nativeProofInteracting?'Release the camera before rendering a proof.':cleanupPreview?'Apply the cleanup preview or return to the original first.':
    !showExport&&hiddenParts.length>0?'Show all product parts before rendering a proof.':
    transformMode?'Apply or cancel the transform before rendering a proof.':materialPreview?'Save or discard the material preview before rendering a proof.':
    renderScene?.comparison?'Use Export to render both comparison views.':!valid||visibleViewportLoading?'Wait for the current view to load.':
    busy?'Wait for the current operation.':samples[frame-1]?.clip?.kind!=='scene'?'Select a 3D scene to render a proof.':'';
  const prepareNativeProof=async():Promise<NativeProofInput>=>{
    if(nativeProofReason)throw new Error(nativeProofReason);
    const source=renderSceneRef.current,view=viewport.current,key=nativeProofScopeRef.current,at=frameRef.current;
    const sample=samplesRef.current[at-1];
    if(!source||!sample||evaluatedScene.current!==source)throw new Error('Wait for the current view to load.');
    if(!view){
      if(!graphicsError.a)throw new Error('Wait for the current view to load.');
      return {scene:source,frame:at,sourceDigest:digest,sourceKey:key,...nativeProofSize(source.render.width/source.render.height),samples:32,viewLabel:'Shot camera'};
    }
    await view.setSample(sample);
    if(nativeProofScopeRef.current!==key||renderSceneRef.current!==source||frameRef.current!==at)throw new DOMException('The view changed.','AbortError');
    const pose=view.getProofView();if(!pose)throw new Error('Wait for the current camera to settle, then try again.');
    const {aspect,inspection,...cameraOverride}=pose;
    return {scene:source,frame:at,sourceDigest:digest,sourceKey:key,...nativeProofSize(aspect),samples:32,cameraOverride,
      viewLabel:inspection?'Inspection view · saved shot unchanged':'Shot camera'};
  };
  const railWidth=340;
  return <div className="studio gesso-studio" data-export-active={showExport} ref={editorRoot} data-section-type={sectionType} style={{'--rail-width':`${railWidth}px`} as React.CSSProperties}>
    <header className="gesso-topbar" ref={menuHost} data-frame-outside>
      {columnGuides&&<div className="gesso-column-guides" aria-hidden="true">{Array.from({length:7},(_,index)=><span key={index}/>)}</div>}
      <div className="gesso-appbar">
        <a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a>
        <nav className="gesso-appmenus" aria-label="Application">
          {['File','Edit','View'].map(name=><button key={name} aria-expanded={menu===name} onClick={()=>setMenu(menu===name?null:name)}>{name}</button>)}
          {['Plugins','Widgets'].map(name=><button key={name} className="gesso-reserved-menu" disabled title={`${name} are not available in this prototype`}>{name}</button>)}
        </nav>
        <div className="gesso-header-actions">
          <button className="gesso-preset-action" aria-haspopup="dialog" disabled={presetBlocked} title={presetReason||'Save selected parts of this setup'} onClick={()=>openPreset('save')}>Save preset</button>
          <button className="gesso-preset-action" aria-haspopup="dialog" disabled={presetBlocked} title={presetReason||'Open saved setup presets'} onClick={()=>openPreset('library')}>Presets</button>
          <button className="gesso-header-icon" aria-label="Undo" title={randomPreview?"Return to Current scene to undo campaign edits":"Undo (⌘/Ctrl Z)"} disabled={!!cleanupPreview||randomPreview||!canUndo(history)} onClick={undo}><UiIcon name="undo"/></button>
          <button className="gesso-header-icon" aria-label="Redo" title={randomPreview?"Return to Current scene to redo campaign edits":"Redo (⌘/Ctrl Shift Z)"} disabled={!!cleanupPreview||randomPreview||!canRedo(history)} onClick={redo}><UiIcon name="redo"/></button>
          <button className="gesso-header-icon" aria-label="History" title="History" aria-expanded={menu==='History'} onClick={()=>setMenu(menu==='History'?null:'History')}><UiIcon name="history"/></button>
          <CampaignSaveControl status={saveStatus} preview={savePreview} disabled={!!cleanupPreview||!!transformMode||busy||!project||evaluating} onSave={save}/>
          <img className="gesso-avatar" src={avatar} alt=""/>
        </div>
      </div>
      <EditorNavigation group={tab} onGroup={chooseWorkspace} exportActive={showExport} onExport={()=>openExport()} onRandomSetup={()=>{if(transformModeRef.current||materialPreviewRef.current){openExport(mode,'random');return;}const settings=productReelSettings(scene);setRandomSettings({source:scene,settings});openExport(mode,'random');generateExportSetup(settings);}} randomSetupActive={randomPreview} exportDisabled={!!cleanupPreview||!scene||busy}/>
      <EditorMenu name={menu} onClose={()=>setMenu(null)}>{shownMenu=><>
        {shownMenu==='File'&&<><div className="gesso-menu-heading">{project?.name??'Opening project…'}</div><button disabled={!!cleanupPreview||!!transformMode||!dirty||busy||evaluating} onClick={()=>{void save();setMenu(null)}}>Save revision <kbd>⌘ S</kbd></button><button onClick={()=>{navigate('product','Model');setShowProductImport(true);setMenu(null)}}>Import product…</button><button disabled={!scene||busy} onClick={()=>openExport()}>Export…</button>    <div className="project-switch"><Field label="Campaign"><select aria-label="Campaign" title={dirty?'Save this revision before switching campaigns':undefined} disabled={busy||dirty} value={project?.id??''} onChange={e=>openCampaign(e.target.value)}>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>{dirty&&<p className="gesso-note">Save this revision to switch campaigns.</p>}<button className="text-button" disabled={busy} onClick={()=>perform(async()=>{const p=await api('/api/projects','POST',{name:`Campaign ${projects.length+1}`,scene});loadProject(p);setProjects(await api('/api/projects'))})}>＋ Duplicate as new campaign</button></div>
</>}
        {shownMenu==='Edit'&&<><button disabled={!!cleanupPreview||randomPreview||!canUndo(history)} onClick={undo}>Undo <kbd>⌘ Z</kbd></button><button disabled={!!cleanupPreview||randomPreview||!canRedo(history)} onClick={redo}>Redo <kbd>⇧ ⌘ Z</kbd></button></>}
        {shownMenu==='View'&&<><button type="button" className="gesso-column-guide-toggle" aria-pressed={columnGuides} onKeyDown={event=>{if(event.key===' ')event.stopPropagation()}} onClick={()=>{setColumnGuides(value=>!value);setMenu(null)}}>Column guides<span aria-hidden="true">{columnGuides?'On':'Off'}</span></button><Field label="Section headings"><select value={sectionType} onChange={event=>setSectionType(event.target.value)}><option value="text">Halyard Text</option><option value="micro">Halyard Micro</option><option value="display">Halyard Display</option></select></Field>{!stillFilm&&!filmWorkspace&&!(productDecals)&&<button onClick={()=>{setShowTimeline(!timelineVisible);setMenu(null)}}>{timelineVisible?'Hide':'Show'} timeline</button>}{(productModel||productDecals)&&<button onClick={()=>{setFocused(v=>!v);setMenu(null)}}>{focused?'Show assembly':'Focus selected part'}</button>}{productWorkspace&&selected&&<button onClick={()=>{framePart();setMenu(null)}}>Frame selected part</button>}<p className="gesso-note"><span className="gesso-meta">Option / Alt 1–3 selects a step.<br/>Option / Alt {tab==='renders'?(stillFilm?'5–6':'5–8'):'5–7'} opens its controls.<br/>Drag to orbit. Shift-drag to pan.<br/>Scroll to zoom.</span></p><a href="/about">About gesso</a><a href="/aperture">Form + light</a></>}
        {shownMenu==='History'&&<><div className="gesso-menu-heading">{project?.name}</div><p className="gesso-note"><span className="gesso-meta">{history.past.length} undo steps · {history.future.length} redo steps</span></p>{!isStaticDemo&&<button disabled={busy} onClick={()=>{setMenu(null);openRecoveryChoices();}}>Review recovery drafts{recoveryCandidates.length?` (${recoveryCandidates.length})`:''}</button>}<button disabled={busy||dirty} onClick={approve}>Approve saved revision</button><button disabled={randomPreview||!project?.approvedRevisionId||busy} onClick={restore}>Restore approved scene</button><p className="gesso-note gesso-feedback" data-tone={dirty?'note':'success'}>{dirty?'Unsaved changes':'Current revision saved locally'}</p></>}
      </>}</EditorMenu>
    </header>
    {presetMode&&scene&&<PresetLibraryDialog mode={presetMode} onClose={()=>setPresetMode(null)} onList={listSetupPresets} onSave={saveSetupPreset} onApply={applySetupPreset}/>}
    <div className={`gesso-workspace ${sideEditorVisible?'with-material-editor':''} ${filmWorkspace?'with-film-workspace':''} ${filmWorkspace&&!stillFilm&&!showExport?'film-has-timeline':''} ${showExport?'with-export-workspace':''} ${filmTimelineRows>0?'film-has-motions':''} ${filmCurves?'film-curves-open':''} ${filmLegacy?'film-legacy-open':''}`} style={{'--film-track-rows':Math.min(filmTimelineRows,3)} as React.CSSProperties}>
      <aside className="gesso-sidebar" data-frame-outside aria-label={`${groupName} controls`} aria-hidden={showExport} inert={showExport||!!sceneCreation}>
        {(productWorkspace||tab==='world')&&<EditorLayerNavigation group={tab==='world'?'world':'product'} layer={layer} onLayer={chooseLayer}/>}
        {scene&&filmWorkspace&&<FilmShotHeader scene={scene} frame={filmEditFrame}/>}
        {scene&&filmWorkspace&&filmEditShot&&shot?.id!==filmEditShot.id&&<button type="button" className="film-return-context" onClick={()=>{resumeFilmEditing();resetView()}}>Return to {filmEditShot.kind==='image'?'Image':'Scene'} {String(scene.shots.indexOf(filmEditShot)+1).padStart(2,'0')}</button>}
        <div className={`gesso-sidebar-content gesso-condensed-sidebar ${productModel&&showProductImport?'has-import':''}`}>
          {transformError&&<div className="message error" role="alert">{transformError}</div>}{materialEditorVisible&&materialPreviewError&&<div className="message error" role="alert">Material preview: {materialPreviewError}</div>}{validationError&&<div className="message error" role="alert">{validationError}</div>}{error&&<div className="message error" role="alert">{error}</div>}
          {!scene&&<p className="gesso-note">{error?'The project could not be opened.':'Opening project…'}</p>}
          {scene&&productWorkspace&&productPanel}{tab==='product'&&filmReturn.current&&<button type="button" className="film-return" onClick={returnToFilm}>Back to Film</button>}
          {productModel&&showProductImport&&<div className="import-form control-section">
            <div className="gesso-section-heading">Import product <button aria-label="Close import" onClick={()=>closeProductImport(true)}>×</button></div>
            <div className="gesso-import-body">
              <Field label="Product name"><input disabled={productImporting} value={productName} onChange={e=>setProductName(e.target.value)}/></Field>
              <Field label="Product owner"><input disabled={productImporting} value={productOwner} onChange={e=>setProductOwner(e.target.value)}/></Field>
              <Field label="Source URL or reference"><input disabled={productImporting} value={productSource} onChange={e=>setProductSource(e.target.value)}/></Field>
              <Field label="Usage permission or license"><input disabled={productImporting} value={productReuse} onChange={e=>setProductReuse(e.target.value)}/></Field>
              <p className="small-copy">GLB, Blender, STEP, IGES, STL, OBJ or PLY · up to 128 MB.</p>
              <input aria-label="Product file" type="file" accept={productImportAccept} ref={productFile} disabled={productImporting} onChange={e=>{setProductFilename(e.target.files?.[0]?.name??'');setProductSourceUp('z');setProductSourceUnits('');}}/>
              {(productFormat==='cad'||productFormat==='mesh')&&<Field label="Source up axis"><select value={productSourceUp} disabled={productImporting} onChange={e=>setProductSourceUp(e.target.value as ProductSourceUp)}><option value="z">Z up</option><option value="y">Y up</option></select></Field>}
              {(productFormat==='mesh'||productFormat==='blend')&&<Field label="Source units"><select value={productSourceUnits} disabled={productImporting} onChange={e=>setProductSourceUnits(e.target.value as ProductSourceUnits)}><option value="">{productFormat==='blend'?'Use file units':'Choose file units…'}</option><option value="mm">Millimeters</option><option value="cm">Centimeters</option><option value="m">Meters</option><option value="in">Inches</option><option value="ft">Feet</option></select></Field>}
              {productFormat==='cad'&&<p className="small-copy">Units and hierarchy are read from the file where provided. Native CAD files need a STEP or IGES export.</p>}
              {productFormat==='mesh'&&<p className="small-copy">Choose the units used when this mesh was exported. OBJ imports geometry only and PLY keeps vertex colours; use a packed GLB for materials.</p>}
              {productFormat==='blend'&&<p className="small-copy">Imports the active scene at its saved frame. Unsupported materials use neutral surfaces; optional repair steps stay in Import notes. Unspecified Blender units use 1 unit = 1 meter; select source units to override. Cameras, lights and animation are excluded.</p>}
              {productFormat==='glb'&&<p className="small-copy">Use a self-contained GLB in meters. Geometry, hierarchy and supported materials are imported.</p>}
              {!!productFilename&&!productFormat&&<p className="small-copy" role="alert">Choose a supported file type.</p>}
              {productImporting&&<p className="small-copy" role="status">Closing keeps this campaign open. A completed import remains in the campaign library.</p>}
              <button disabled={!productName||!productOwner||!productReuse||!productSource||!productFormat||(productFormat==='mesh'&&!productSourceUnits)||productImporting} onClick={importProduct}>{productImporting?'Importing…':'Import product'}</button>
            </div>
          </div>}

          {scene&&tab==='world'&&<WorldPanel cleanupScopeKey={cleanupScopeKey} cleanupAvailable={!isStaticDemo&&caps.worldCleanupAvailable===true&&!scene.comparison} cleanupBusy={busy||saving||!!transformMode||!!materialPreview||!valid||visibleViewportLoading} cleanupPreview={cleanupPreview} onCleanupPreview={previewWorldCleanup} onCleanupApply={applyWorldCleanup} onCleanupSelection={setCleanupSelection} onCleanupFrame={()=>{if(viewport.current?.frameWorldCleanupSelection()){setPlaying(false);setInspecting(true);setStillViewVersion(value=>value+1);}}} analyzePostProcessing={analyzePostProcessing} postProcessingReady={postProcessingReady&&scene===renderScene} captureCurrentWorld={captureCurrentWorld} worldPreviewReady={!cleanupPreview&&tab==='world'&&!evaluating&&!visibleViewportLoading&&valid&&!playing&&!transformMode&&!showExport} worldPreviewRevision={digest} selectedObjectId={worldObjectId} onSelectObject={setWorldObjectId} editorHost={sideEditorHost} scene={scene} layer={layer as WorldLayer} worlds={worlds} onChange={change} onWorld={replaceWorld} onFitProduct={isStaticDemo||scene.environment.gaussianProtection?undefined:fitProduct} fitDisabled={!!cleanupPreview||!valid||visibleViewportLoading||busy||playing||!!transformMode} onImport={()=>setShowImport(value=>!value)} resolved={evaluatedScene.current===scene?objects:undefined} pickingSurface={pickingSurface} onPickSurface={startSurfacePick} onCancelPick={()=>setPickingSurface(false)} onFrameObjects={isStaticDemo||scene.environment.gaussianProtection?undefined:frameObjects} ready={valid&&!busy&&!cleanupPreview}>
            {showImport&&<div className="import-form"><Field label="World name"><input value={worldName} onChange={e=>setWorldName(e.target.value)}/></Field><Field label="Asset owner"><input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="Your company or creator"/></Field><Field label="Reuse basis"><input value={reuse} onChange={e=>setReuse(e.target.value)} placeholder="License or permission"/></Field><Field label="Source up axis"><select value={sourceUp} onChange={e=>setSourceUp(e.target.value)}><option>Y</option><option>Z</option></select></Field><input aria-label="World export file" type="file" accept=".glb,.spz,.ply" ref={file}/><button disabled={!owner||!reuse||importing} onClick={importFile}>{importing?'Importing…':'Import GLB / SPZ / PLY'}</button></div>}
            {(scene.comparison||worlds.some(world=>world.environment.kind==='mesh'))&&<details className="gesso-disclosure" open={scene.comparison?true:undefined}><summary>Compare environments</summary><ComparisonPanel scene={scene} worlds={worlds} info={comparisonInfo} busy={busy} ready={valid} mode={comparisonMode} drafts={calibrationDrafts} picking={picking} onMode={changeComparisonMode} onEnable={startComparison} onDisable={()=>change(s=>{delete s.comparison})} onWorld={comparisonWorld} onTransform={comparisonTransform} onDraft={draftCalibration} onPick={startPick} onCancelPick={()=>setPicking(null)} onCalibrate={applyCalibration} onReview={reviewComparison}/></details>}
            {!isStaticDemo&&<AtlasWorldPanel request={api} onUse={useAtlasWorld} applyDisabled={busy||!valid||!!scene.comparison}/>}
            <details className="gesso-disclosure"><summary>Generate environment</summary><section className="control-section"><p className="small-copy">Choose a default above to start immediately. Or generate one world and compare World Labs’ mesh with a mesh reconstructed from its Gaussians.</p><Field label="Generation preset"><select value={preset} onChange={e=>setPreset(e.target.value)}><option value="botanical-studio">Botanical studio</option><option value="warm-gallery">Warm limestone gallery</option><option value="modern-loft">Modern loft</option></select></Field><Field label="Reference image URL (optional)"><input type="url" value={imageUrl} onChange={e=>setImageUrl(e.target.value)} placeholder="https://…/reference.jpg"/></Field><p className="small-copy">Use a public HTTPS image URL, or leave blank to generate from the preset. Private image files can use the local CLI. Your key stays encrypted in GitHub.</p><NumberControl label="API credit limit" value={creditLimit} min={5080} max={6000} step={100} onChange={setCreditLimit}/><p className="small-copy">Matching image and preset reuse saved results; product, camera and scene edits need no new generation. A new standard world + textured mesh costs about 5,080 API credits ($4.06). No automatic paid retries.</p><label className="gesso-check"><input type="checkbox" checked={forceNew} onChange={e=>setForceNew(e.target.checked)}/><span>Generate a new variation (uses credits)</span></label><button className="wide" disabled={busy||!caps.githubWorldsAvailable} onClick={generate}>{forceNew?'Generate new variation ↗':'Reuse or generate mesh comparison ↗'}</button><a className="text-link" style={{marginTop:12}} href={caps.githubWorkflowUrl??'https://github.com/kimestelle/3d-product-suite/actions/workflows/worldlabs-pair.yml'} target="_blank" rel="noreferrer">Open GitHub workflow ↗</a><button className="text-button" disabled={busy} onClick={refreshRuns}>Refresh generation runs</button>{remoteRuns.map(run=><article key={run.id} className="job"><div className="job-heading"><b>{run.name}</b><span className="job-state">{run.conclusion??run.status}</span></div><a className="text-link" href={run.url} target="_blank" rel="noreferrer">View generation ↗</a>{run.conclusion==='success'&&<button className="wide" style={{marginTop:12}} disabled={busy} onClick={()=>importRun(run.id)}>Import both meshes</button>}</article>)}</section></details>
          </WorldPanel>}
          {scene&&filmWorkspace&&(frameSetupProps?<FrameSetupObjects {...frameSetupProps}/>:!filmSceneSelected?<FilmClipDetails {...filmClipProps} side="objects"/>:<FilmObjects {...filmProps}/>)}

        </div>
        <footer className="gesso-sidebar-footer"><span>{productWorkspace||animatorVisible?`${availableParts.length} parts · millimeters`:project?.name??'Local workspace'}</span><span className="gesso-feedback" data-tone={evaluating?'note':validationError?'error':'success'} title={validationError||'Live preview'}>{evaluating?'Updating…':validationError?'Needs attention':'Live'}</span></footer>
      </aside>
      {showExport&&scene&&setupSettings&&<aside className="gesso-sidebar gesso-export-setup-sidebar" data-frame-outside aria-label="Export source"><ExportSetupPanel sourceScene={scene} tab={exportSetupTab} onTab={chooseExportSetup} settings={setupSettings} onSettings={updateRandomSettings} worlds={worlds} changes={exportDraft?.changes??[]} hasDraft={!!exportDraft} dirty={randomSettingsDirty} busy={busy} error={randomSetupError||(randomPreview?validationError:'')} onGenerate={()=>generateExportSetup()} keepDisabled={!valid||evaluating||visibleViewportLoading||!!validationError} onKeep={()=>{if(!exportDraft||randomSettingsDirty||!valid||evaluating||visibleViewportLoading||validationError||!allowSceneEdit())return;setPlaying(false);setHistory(h=>commitHistory(h,exportDraft.scene));setRandomDraft(null);setExportSetupTab('current');navigate('renders','Framing');setNotice('Generated film applied · Undo to restore','success')}}/></aside>}
      <main className={`gesso-stage ${timelineVisible&&!filmWorkspace?'with-timeline':''} ${filmWorkspace?'with-film-timeline':animatorVisible?'with-keyframes':''}`} aria-label={showExport?"Export preview":"Product window"}>
        {showComparison&&!showExport&&<div className="comparison-toolbar" data-frame-outside><div className="segmented" aria-label="Comparison display">{(['a','b','split'] as const).map(mode=><button key={mode} aria-pressed={comparisonMode===mode} onClick={()=>changeComparisonMode(mode)}>{mode==='split'?'Split':mode.toUpperCase()}</button>)}</div><span className="comparison-status">{valid&&comparisonInfo?.alignmentStatus==='reviewed'?'Placement reviewed':'Draft placement'}</span><button onClick={()=>{navigate('world','Environment')}}>Adjust placement</button></div>}
        <FrameWindow className={`viewport-wrap ${showComparison?'has-comparison':''} ${filmGuidesVisible?'with-film-guides':''}`} ref={stageHost}>
          <div className={`comparison-stage ${showComparison&&previewComparisonMode==='split'?'split':''}`} aria-busy={visibleViewportLoading} inert={stillShowing||exportReviewVisible} aria-hidden={stillShowing||exportReviewVisible}>
            <div className={`comparison-pane ${showComparison&&previewComparisonMode==='b'?'pane-hidden':''} ${picking?.side==='a'?'picking':''}`}><div className="viewport" ref={host} tabIndex={0} aria-label={showComparison?'Environment A scene':'Interactive product scene'}/>{showExport&&renderScene&&<ExportPreviewMask aspect={renderScene.render.width/renderScene.render.height}/>}{tab==='world'&&!cleanupPreview&&!inspecting&&!playing&&productFitGuide?.scene===scene&&productFitGuide?.frame===frame&&<ProductFitGuide rect={productFitGuide.a} aspect={scene.render.width/scene.render.height}/>}{showComparison&&<div className="comparison-view-label"><b>A</b><span>{labels.a}</span></div>}</div>
            <div className={`comparison-pane ${!showComparison||previewComparisonMode==='a'?'pane-hidden':''} ${picking?.side==='b'?'picking':''}`}><div className="viewport" ref={hostB} aria-label="Environment B scene"/>{showExport&&showComparison&&renderScene&&<ExportPreviewMask aspect={renderScene.render.width/renderScene.render.height}/>}{tab==='world'&&!cleanupPreview&&!inspecting&&!playing&&productFitGuide?.scene===scene&&productFitGuide?.frame===frame&&productFitGuide.b&&<ProductFitGuide rect={productFitGuide.b} aspect={scene.render.width/scene.render.height}/>}{showComparison&&<div className="comparison-view-label"><b>B</b><span>{labels.b}</span></div>}</div>
          </div>
          <div style={{display:'contents',visibility:stillShowing?'hidden':undefined}} inert={stillShowing} aria-hidden={stillShowing}>
          {scene&&!showExport&&filmGuidesVisible&&<FilmViewportControls {...filmCamera} guide={filmCamera.guide??filmGuide} scene={scene} frame={frame} mode={mode} editing={!sceneCreation&&filmTarget==='$camera'&&layer!=='Output'&&!playing&&frame===filmEditFrame} disabled={!!sceneCreation||!valid||playing||busy||frame!==filmEditFrame}/>}
          {scene&&productDecals&&<UvDecalOverlay layout={uvLayout} decal={activeDecal} partName={selectedPart?displayPartName(scene,selectedPart.id,selectedPart.name):'Part'} onPlace={placeDecal} onAdd={addDecal} onHover={hoverUv} onInteractionSurface={decalInteractionSurface}/>}
          {scene&&<TransformShortcuts scene={scene} frame={frame} target={transformTarget} enabled={active&&!stillShowing&&!showExport&&!frameSetup&&!sceneCreation&&!playing&&frame===filmEditFrame&&filmWorkspace&&filmSceneSelected&&filmTarget!=='$camera'&&!isLightTarget(filmTarget)&&layer!=='Output'&&!filmOwners.length&&valid&&!busy&&!materialPreview} viewport={host.current} createGesture={(target,pointer)=>viewport.current?.createTransformGesture(target,pointer,materializeAnimatedPose(transformDraft??scene,frame))??null} onStart={startTransform} onPreview={previewTransform} onCommit={commitTransform} onMode={updateTransformMode}/>}
          {materialPreview&&materialEditorVisible&&<div className="gesso-material-preview-label" role="status" aria-label="Material preview"><UiIcon name="circle"/>Preview</div>}
          </div>
          {renderScene&&<NativeProof scopeKey={nativeProofScope} viewKey={`${project?.id}:${frame}:${stillViewVersion}:${mode}:${filmGuidesVisible}:${filmWorkspace}:${showExport}:${productWorkspace}`} ownerKey={project?.id??''} active={nativeProofActive} ready={!nativeProofReason} disabledReason={nativeProofReason} prepare={prepareNativeProof} onPresent={setNativeProofShowing}/>}
          {!showExport&&<ViewportStill scopeKey={stillScope} disabledReason={stillBlocked} onRender={renderStill} onPresent={showStill}/>}
          {cleanupPreview&&<div className="pick-hint" role="status">{cleanupPreview.label} · not applied<button onClick={()=>previewWorldCleanup(null)}>Return to current world</button></div>}
          {picking&&<div className="pick-hint" role="status">View {picking.side.toUpperCase()}: click {picking.kind==='floor'?'the floor':`measurement point ${calibrationDrafts[picking.side].points.length+1} of 2`}<button onClick={()=>setPicking(null)}>Cancel</button></div>}
          {pickingSurface&&<div className="pick-hint" role="status">Click a level surface in the world to place the product.<button onClick={()=>setPickingSurface(false)}>Cancel</button></div>}
          {!showExport&&!stillShowing&&!nativeProofShowing&&stageObjectVisible&&<div className="gesso-view-toolbar gesso-stage-transform-toolbar" role="group" aria-label="Selected object tools">
            {stageProduct&&<span>Product placement</span>}
            {stageToolsEnabled&&<>
            {!stagePlinth&&<><button type="button" aria-pressed={activeStageMode==='translate'} disabled={stageMoveLocked} title={stageMoveLocked?'Position follows the object relationship':undefined} onClick={()=>setStageTransformMode('translate')}>Move</button>
            <button type="button" aria-pressed={activeStageMode==='rotate'} onClick={()=>setStageTransformMode('rotate')}>Rotate</button></>}
            <button type="button" aria-pressed={activeStageMode==='scale'} onClick={()=>setStageTransformMode('scale')}>Resize</button>
            </>}
            {!scene?.environment.gaussianProtection&&<button type="button" disabled={!valid} onClick={()=>{if(stageObjectId)frameProp(stageObjectId)}}>{stageProduct?'Frame product':'Frame selected object'}</button>}
          </div>}
          {!showExport&&!stillShowing&&!nativeProofShowing&&filmWorkspace&&(inspecting&&filmSceneVisible||!playing&&frame!==filmEditFrame)&&<div className="gesso-view-toolbar" role="group" aria-label="Film view">
            {inspecting&&filmSceneVisible&&<button type="button" onClick={resetView} title="Leave inspection view and show the saved shot framing">Use shot camera</button>}
            {!playing&&frame!==filmEditFrame&&<button type="button" onClick={()=>previewFrame(frame)}>Edit this frame</button>}
          </div>}
          {showExport&&!exportReviewVisible&&<ExportPreviewTransport mode={mode} frame={frame} total={total} fps={fps} playing={playing} disabled={!valid||visibleViewportLoading||busy} onPlay={togglePlayback} onFrame={previewExportFrame} paired={showComparison} sourceLabel={randomPreview?(exportDraft?'Random setup':'Current scene · choose a setup'):'Current scene'}/>}
          {exportReviewVisible&&exportReview&&<ExportArtifactPreview key={`${exportReview.job.id}-${!!exportReview.job.paired}`} job={exportReview.job} currentDigest={digest} onBack={returnToExportPreview}/>}
          <ViewportLoading loading={visibleViewportLoading}/>
          {(graphicsError.a||showComparison&&graphicsError.b||validationError)&&<div className="gesso-render-status" role="status">{graphicsError.a||(showComparison&&graphicsError.b)||'Preview needs attention'}</div>}
        </FrameWindow>
        {!filmWorkspace&&<div className="timeline-reveal" data-frame-outside aria-hidden={!timelineVisible} inert={!timelineVisible}><section className="timeline" aria-label="Shot timeline"><div className="transport"><span className="timecode">{((frame-1)/fps).toFixed(2)} / {(total/fps).toFixed(2)}s</span><div className="transport-right"><NumberField label="Frame" value={frame} onChange={n=>{setPlaying(false);setFrame(Math.max(1,Math.min(total,Math.round(n))))}} min={1} max={total} step={1}/><span>Space to play · ← → scrub</span></div></div><input className="scrubber" aria-label="Scrub scene" type="range" min={1} max={total} value={frame} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value))}}/><div className="shots">{scene?.shots.map((item:any,i:number)=><button className={`shot ${item.id===shot?.id?'selected':''}`} key={item.id} onClick={()=>{setPlaying(false);setFrame(item.startFrame)}} style={{flex:item.endFrame-item.startFrame+1}}><span>{String(i+1).padStart(2,'0')}　{item.name}</span><small>{((item.endFrame-item.startFrame+1)/fps).toFixed(1)}s</small></button>)}</div></section></div>}
      </main>
      {scene&&filmWorkspace&&!showExport&&<aside className="gesso-sidebar film-inspector-rail" data-frame-outside aria-label="Film inspector" onPointerDownCapture={resumeFilmEditing} onFocusCapture={resumeFilmEditing}>
        <FilmModeTabs mode={mode} onMode={next=>{resumeFilmEditing();setMode(next);setMenu(null)}}/>
        <div className="gesso-sidebar-content">
        {sceneCreation?.step==='choose'?<NewSceneChooser disabled={busy||!valid} onProduct={()=>{setSceneCreation(null);beginFrameSetup()}} onStatic={()=>setSceneCreation({step:'static'})} onCancel={()=>cancelSceneCreation()}/>:sceneCreation?.step==='static'?<StaticSceneComposer key={sceneCreation.shotId??'new'} width={scene.render.width} height={scene.render.height} fps={fps} editing={!!sceneCreation.shotId} disabled={busy||!valid} initial={staticEditingShot?{name:staticEditingShot.name,durationSeconds:(staticEditingShot.endFrame-staticEditingShot.startFrame+1)/fps,card:isFilmTextCard(staticEditingShot.image?.textCard)?staticEditingShot.image.textCard:undefined}:undefined} onSubmit={submitStaticScene} onCancel={()=>cancelSceneCreation(true)}/>:frameSetupProps?<FrameSetupInspector {...frameSetupProps}/>:!filmSceneSelected?<FilmClipDetails {...filmClipProps} side="inspector"/>:<FilmInspector {...filmProps} onEditMechanism={editFilmMechanism}>{filmPoseContent}</FilmInspector>}
      </div></aside>}
      {showExport&&renderScene&&<aside className="gesso-sidebar gesso-export-sidebar" data-frame-outside aria-label="Export settings">{error&&<div className="message error" role="alert">{error}</div>}<ExportPanel scene={renderScene} onReviewJob={reviewExportJob} postProcessing={(!randomPreview||exportDraft)?<PostProcessingPanel scene={renderScene} onChange={changeExport} analyzePostProcessing={analyzePostProcessing} ready={postProcessingReady}/>:undefined} previewSource={renderScene} projectName={project?.name??'gesso'} frame={frame} initialMode={mode} compositionSettings={!randomPreview?<FilmPanel outputOnly scene={scene} mode={mode} layer="Output" frame={frame} onChange={changeExport} onFrame={previewExportFrame}/>:exportDraft?<FilmPanel outputOnly scene={renderScene} mode={mode} layer="Output" frame={frame} onChange={changeExport} onFrame={previewExportFrame}/>:undefined} onModeChange={next=>{setPlaying(false);setMode(next)}} capabilities={caps} blockedReason={exportBlockedReason} jobs={combinedExportJobs(jobs,pairJobs)} currentDigest={digest} onSubmit={submitExport} onControl={controlExport} onClose={closeExport} onAdjustFrame={randomPreview?undefined:nextMode=>{setPlaying(false);navigate('renders','Framing',nextMode);viewport.current?.resetFraming();viewportB.current?.resetFraming()}}/></aside>}
      <aside className="gesso-sidebar gesso-material-editor" data-frame-outside aria-label={worldEditorVisible?"World object editor":"Material preset editor"} aria-hidden={!sideEditorVisible} inert={!sideEditorVisible}>
        <div className="gesso-sidebar-content gesso-material-editor-content" ref={setSideEditorHost}/>
      </aside>
      {scene&&filmWorkspace&&!showExport&&<div className="film-timeline-dock" data-frame-outside aria-hidden={stillFilm} inert={stillFilm}><FilmTimeline {...filmProps} detailContent={filmLegacy?<div className="film-legacy-editor"><div className="film-legacy-heading"><button type="button" onClick={()=>setFilmLegacy(false)}><UiIcon name="undo"/> Back to shots</button><span>Custom keyframes · Across cuts</span></div>
            {!!filmOwners.length&&<p className="film-owner-note">Pause the selected object's motion before editing its underlying keys.</p>}
            <KeyframeEditor embedded scene={transformDraft??scene} componentId={filmTarget.startsWith('$')?null:filmTarget} frame={frame} onFrame={previewFrame} onChange={changeFilm} playing={playing} onPlay={filmProps.onPlay!} disabled={filmProps.disabled||!!filmOwners.length||frame!==filmEditFrame} scope={positionSpace} onScopeChange={space=>{setPositionSpace(space);if(space==='world')setFilmTarget('$product');else if(transformPart)setFilmTarget(transformPart.id)}}/>
          </div>:undefined}/></div>}
    </div>

    {!isStaticDemo&&project&&recoveryOpen&&<RecoverDraftDialog drafts={recoveryCandidates} revisionId={recoveryRevisionId} separate={recoverySeparate} busy={recoveryBusy} error={recoveryError}
      onRestore={draft=>{void restoreRecovery(draft);}} onDiscard={discardRecovery} onKeepSaved={()=>{setRecoveryOpen(false);setRecoveryError('');}}/>}
    {importDecision&&<ImportDecisionDialog projectName={project?.name??'This campaign'} busy={importDecisionBusy} error={importDecisionError}
      onSave={()=>{void resolveImportDecision(true);}} onDiscard={()=>{void resolveImportDecision(false);}} onCancel={()=>{setImportDecision(null);setImportDecisionError('');}}/>}
    {draftStorageError&&<div className="gesso-recovery-alert" role="alert">{draftStorageError}</div>}
    {notice&&<div className="gesso-notice" data-frame-outside role="status"><span className="gesso-feedback" data-tone={notice.tone}>{notice.message}</span><button aria-label="Dismiss notification" onClick={()=>setNotice('')}>×</button></div>}
    <div className="gesso-small-screen" data-frame-outside><a className="gesso-wordmark" href="/landing" aria-label="gesso home">gesso<span>studio</span></a><p>Open the editor in a wider window.</p><span>900 px gives the product and its controls room to work.</span></div>
  </div>

}
export const StudioEditor = memo(Editor);
const renderEditor = (props: StudioEditorProps) => <StudioEditor {...props}/>;
export default function App(){return location.pathname==='/capture'?<Capture/>:<StudioEntry renderEditor={renderEditor}/>}
