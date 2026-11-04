import {createViewport,type ViewportPart} from './viewport';
import './worldComparison.css';

type World={id:string;name:string;environment:any};
type PoseName='front'|'wide'|'side'|'higher';
type Pose={positionM:number[];targetM:number[];focalLengthMm:number};
type Capture={worldId:string;representationId:string;label:string;view:PoseName;camera:Pose;sha256:string;state:'pending'|'ready'|'failed';error?:string;width?:number;height?:number;url?:string};
const poses:Record<PoseName,Pose>={
  front:{positionM:[0,0,0],targetM:[0,0,-3],focalLengthMm:36},
  wide:{positionM:[0,0,0],targetM:[0,0,-3],focalLengthMm:24},
  side:{positionM:[1,0,0],targetM:[0,0,-3],focalLengthMm:24},
  higher:{positionM:[0,1,0],targetM:[0,0,-3],focalLengthMm:24},
};
const element=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const worldSelect=element<HTMLSelectElement>('world'),representationSelect=element<HTMLSelectElement>('representation');
const refreshButton=element<HTMLButtonElement>('refresh'),captureButton=element<HTMLButtonElement>('capture');
const cancelButton=element<HTMLButtonElement>('cancel'),manifestButton=element<HTMLButtonElement>('manifest');
const status=element('status'),errorOutput=element('error'),sourceOutput=element('source'),results=element('results');
const query=new URLSearchParams(location.search);
let viewName:PoseName=Object.hasOwn(poses,query.get('view')??'')?query.get('view') as PoseName:'front';
let worlds:World[]=[],baseScene:any,selectedWorldId='',selectedRepresentationId='',loadedRepresentationId='';
let sampled:any=null,hiddenParts:string[]=[],loadError='',busy=false,disposed=false,cancelled=false;
let request=0,currentAbort:AbortController|null=null,captures:Capture[]=[],batchStartedAt:string|null=null;
const objectUrls=new Set<string>();
const viewport=createViewport(element('viewport'),{
  studioMode:true,
  onParts:(parts:ViewportPart[])=>{hiddenParts=parts.map(part=>part.id);},
  onError:message=>{loadError=message;showError(message);},
});
viewport.setInspectionEnabled(false);viewport.setFilmContent(true);viewport.setFilmGuides(false);viewport.setProductPreview(false);

function isReference(world:World){return world.environment?.kind==='mesh'&&world.environment?.provenance?.referenceOnly===true;}
function providerId(world:World){return isReference(world)?`reference:${world.id}`:world.environment?.provenance?.providerWorldId as string|undefined;}
function available(world:World){const e=world.environment,p=e?.provenance;return isReference(world)||!e?.fixture&&typeof p?.providerWorldId==='string'&&!!p.providerWorldId.trim()
  &&((e.kind==='mesh'&&p.representation==='hq-visual-glb')||(e.kind==='splat'&&p.representation==='gaussian-spz'));}
function representationLabel(world:World){const p=world.environment.provenance;
  if(isReference(world))return 'Authored geometry control';
  if(world.environment.kind==='mesh')return p.meshVariant==='vertex_colored'?'Vertex-colored mesh':'Textured mesh';
  return p.splatResolution==='full_res'?'Gaussian · full resolution':`Gaussian · ${p.splatResolution??'source'}`;
}
function representationOrder(world:World){const p=world.environment.provenance;
  if(isReference(world))return 0;
  if(world.environment.kind==='mesh')return p.meshVariant==='vertex_colored'?1:0;
  return p.splatResolution==='full_res'?3:2;
}
function choices(){return worlds.filter(world=>providerId(world)===selectedWorldId)
  .sort((a,b)=>representationOrder(a)-representationOrder(b)||a.id.localeCompare(b.id));}
function currentWorld(){return worlds.find(world=>world.id===selectedRepresentationId);}
function showError(message=''){errorOutput.textContent=message;errorOutput.hidden=!message;}
function setBusy(value:boolean){busy=value;worldSelect.disabled=value||!worlds.length;representationSelect.disabled=value||!choices().length;
  refreshButton.disabled=value;captureButton.disabled=value||!choices().length;cancelButton.hidden=!value;cancelButton.disabled=false;
  for(const button of element('views').querySelectorAll('button'))button.disabled=value;
  manifestButton.disabled=value||!captures.length;
}
function markView(){for(const button of element('views').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.view===viewName));}
function saveLocation(){const value=new URL(location.href);value.search='';if(selectedWorldId)value.searchParams.set('world',selectedWorldId);
  if(selectedRepresentationId)value.searchParams.set('representation',selectedRepresentationId);value.searchParams.set('view',viewName);history.replaceState(null,'',value);}
function updateSource(){const world=currentWorld();if(!world)return;const p=world.environment.provenance,quality=p.visualQuality;
  element('method').textContent=isReference(world)
    ?'Authored geometry control. Exact modeled surfaces; not a model output or a reconstruction of the generated world. The camera uses construction units. No grading or depth of field.'
    :'Same source-space camera; metric alignment unreviewed. Mesh / Gaussian coordinate agreement is approximate. Gaussian density variants use the same transform. No grading or depth of field.';
  const count=Number.isSafeInteger(quality?.triangleCount)?`${quality.triangleCount.toLocaleString()} triangles · `:'';
  sourceOutput.textContent=`${representationLabel(world)} · ${count}SHA-256 ${world.environment.asset.sha256} · camera ${JSON.stringify(poses[viewName].positionM)} → ${JSON.stringify(poses[viewName].targetM)} · ${poses[viewName].focalLengthMm}mm`;
}
function populateRepresentations(){const entries=choices(),counts=new Map<string,number>();
  for(const world of entries){const label=representationLabel(world);counts.set(label,(counts.get(label)??0)+1);}
  representationSelect.replaceChildren(...entries.map(world=>{const option=document.createElement('option');option.value=world.id;
    const label=representationLabel(world);option.textContent=(counts.get(label)??0)>1?`${label} · ${world.id}`:label;return option;}));
  if(!entries.some(world=>world.id===selectedRepresentationId))selectedRepresentationId=entries[0]?.id??'';
  representationSelect.value=selectedRepresentationId;updateSource();saveLocation();
}
async function api(path:string,body?:unknown,signal?:AbortSignal){const response=await fetch(path,{credentials:'same-origin',signal,
  ...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Product-Suite':'1'},body:JSON.stringify(body)})});
  const payload=await response.json();if(!response.ok)throw new Error(payload.error||`Request failed (${response.status})`);return payload;
}
function probeScene(world:World){const scene=structuredClone(baseScene),environment=structuredClone(world.environment);
  delete scene.comparison;delete scene.postProcessing;delete scene.animation;delete scene.motions;delete scene.filmAudio;delete scene.audio;
  scene.actions=[];delete environment.previewAsset;environment.asset.scaleToMeters=1;environment.asset.translationM=[0,0,0];environment.previewQuality='detail';
  if(environment.kind!=='mesh')delete environment.previewQuality;
  environment.plinth=structuredClone(baseScene.environment.plinth);environment.plinth.visible=false;delete environment.plinth.relationship;
  environment.props=[];environment.floorY=-20;environment.worldColor=[.05,.05,.05];
  scene.environment=environment;scene.placement={translationM:[0,0,0],scale:scene.placement?.scale??1,restsOn:environment.plinth.id};
  scene.render={...scene.render,width:1280,height:720,durationFrames:2};
  const pose=structuredClone(poses[viewName]);scene.shots=[{id:'world-comparison',name:'World comparison',startFrame:1,endFrame:2,camera:{from:pose,to:structuredClone(pose)}}];
  return scene;
}
function assertCurrent(id:number){if(disposed||cancelled||id!==request)throw new DOMException('Comparison cancelled.','AbortError');}
async function installRepresentation(world:World,id:number,signal:AbortSignal){assertCurrent(id);loadError='';loadedRepresentationId='';showError();
  selectedRepresentationId=world.id;representationSelect.value=world.id;updateSource();saveLocation();status.textContent=`Loading ${representationLabel(world)}…`;
  const evaluated=await api('/api/evaluate',{scene:probeScene(world),frame:1},signal);assertCurrent(id);
  await viewport.setScene(evaluated.scene,evaluated.sample);assertCurrent(id);
  if(loadError)throw new Error(loadError);
  viewport.setHiddenParts(hiddenParts);await viewport.setSample(evaluated.sample);assertCurrent(id);
  if(loadError)throw new Error(loadError);
  sampled=evaluated.sample;loadedRepresentationId=world.id;selectedRepresentationId=world.id;representationSelect.value=world.id;updateSource();saveLocation();
  status.textContent=`${representationLabel(world)} · ${viewName} view ready`;
}
async function operation(task:(id:number,signal:AbortSignal)=>Promise<void>){if(busy||disposed)return;setBusy(true);cancelled=false;showError();const id=++request;
  const abort=new AbortController();currentAbort=abort;
  try{await task(id,abort.signal);}catch(error){if(!disposed&&id===request){if(error instanceof DOMException&&error.name==='AbortError'){status.textContent='Comparison cancelled';}
      else{const message=error instanceof Error?error.message:String(error);viewport.clearScene();showError(message);status.textContent='Preview needs attention';loadedRepresentationId='';}}}
  finally{if(id===request&&!disposed){currentAbort=null;setBusy(false);}}
}
async function changeRepresentation(){const world=currentWorld();if(!world)return;await operation((id,signal)=>installRepresentation(world,id,signal));}
async function changeView(next:PoseName){if(busy)return;viewName=next;markView();updateSource();saveLocation();const world=currentWorld();if(!world)return;
  await operation(async(id,signal)=>{if(loadedRepresentationId!==world.id||!sampled){await installRepresentation(world,id,signal);return;}
    // Camera changes consume the sampled pose directly; the loaded world and
    // product assets are not rebuilt for each inspection view.
    const nextSample=structuredClone(sampled);nextSample.camera={...nextSample.camera,...structuredClone(poses[viewName]),depthOfField:{...nextSample.camera.depthOfField,enabled:false}};
    await viewport.setSample(nextSample);assertCurrent(id);if(loadError)throw new Error(loadError);sampled=nextSample;status.textContent=`${representationLabel(world)} · ${viewName} view ready`;
  });
}
function clearCaptures(){for(const capture of captures)if(capture.url){URL.revokeObjectURL(capture.url);objectUrls.delete(capture.url);}captures=[];batchStartedAt=null;results.replaceChildren();element('capture-note').textContent='Each image uses the same fixed camera and the editor’s actual renderer. Captures run one at a time.';}
function openImage(capture:Capture,trigger:HTMLElement){if(!capture.url)return;const dialog=document.createElement('dialog');dialog.className='image-dialog';
  const header=document.createElement('header'),title=document.createElement('span'),close=document.createElement('button'),image=document.createElement('img');
  title.textContent=`${capture.label} · ${capture.view}`;close.type='button';close.textContent='Close';image.src=capture.url;image.alt=title.textContent;
  close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{dialog.remove();trigger.focus();},{once:true});header.append(title,close);dialog.append(header,image);document.body.append(dialog);dialog.showModal();close.focus();
}
function renderCaptures(){results.replaceChildren(...captures.map(capture=>{const figure=document.createElement('figure'),caption=document.createElement('figcaption'),detail=document.createElement('small');
  caption.textContent=capture.label;detail.className='capture-detail';detail.textContent=`${capture.view} · ${capture.width??'—'} × ${capture.height??'—'} · asset ${capture.sha256.slice(0,12)}`;caption.append(detail);figure.append(caption);
  if(capture.state==='ready'&&capture.url){const image=document.createElement('img');image.src=capture.url;image.alt=`${capture.label}, ${capture.view} view`;image.tabIndex=0;
    image.setAttribute('role','button');image.setAttribute('aria-label',`Enlarge ${capture.label}`);image.addEventListener('click',()=>openImage(capture,image));image.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openImage(capture,image);}});
    const link=document.createElement('a');link.className='capture-download';link.href=capture.url;link.download=`${capture.representationId}-${capture.view}.png`;link.textContent='Download PNG';figure.append(image,link);
  }else{const state=document.createElement('div');state.className='capture-state';state.textContent=capture.state==='failed'?`Capture failed: ${capture.error}`:'Waiting for this capture';figure.append(state);}return figure;}));
}
async function captureAll(){const entries=choices();if(!entries.length)return;
  await operation(async(id,signal)=>{clearCaptures();batchStartedAt=new Date().toISOString();const time=new Date(batchStartedAt).toLocaleTimeString();
    captures=entries.map(world=>({worldId:selectedWorldId,representationId:world.id,label:representationLabel(world),view:viewName,camera:structuredClone(poses[viewName]),sha256:world.environment.asset.sha256,state:'pending'}));renderCaptures();
    element('capture-note').textContent=`${entries.length} representations · ${viewName} view · ${time}. One renderer, sequential captures. Failed loads remain explicit.`;
    for(let index=0;index<entries.length;index++){const world=entries[index],capture=captures[index];assertCurrent(id);
      try{await installRepresentation(world,id,signal);assertCurrent(id);status.textContent=`Capturing ${index+1} / ${entries.length}: ${capture.label}…`;
        const still=await viewport.captureStill(signal);assertCurrent(id);if(loadError)throw new Error(loadError);
        capture.url=URL.createObjectURL(still.blob);objectUrls.add(capture.url);capture.width=still.width;capture.height=still.height;capture.state='ready';
      }catch(error){assertCurrent(id);capture.state='failed';capture.error=error instanceof Error?error.message:String(error);loadError=capture.error;loadedRepresentationId='';viewport.clearScene();}
      renderCaptures();
    }
    const complete=captures.filter(capture=>capture.state==='ready').length;status.textContent=`Captured ${complete} / ${entries.length} representations · ${viewName}${loadedRepresentationId?'':' · live preview needs attention'}`;
    showError(loadError);updateSource();saveLocation();
  });
}
async function refreshWorlds(){await operation(async(id,signal)=>{status.textContent='Reading local world library…';const payload=await api('/api/worlds',undefined,signal);assertCurrent(id);
    const previousWorldId=selectedWorldId,previousRepresentationId=selectedRepresentationId;
    worlds=(payload as World[]).filter(available);const groups=new Map<string,World[]>();for(const world of worlds){const key=providerId(world)!;groups.set(key,[...(groups.get(key)??[]),world]);}
    worldSelect.replaceChildren(...[...groups].map(([id,entries])=>{const option=document.createElement('option');option.value=id;option.textContent=isReference(entries[0])?'Courtyard · Authored geometry control':entries[0].name.split(' · ')[0];return option;}));
    if(!groups.has(selectedWorldId))selectedWorldId=[...groups].find(([,entries])=>entries.some(world=>/water courtyard/i.test(world.name)))?.[0]??[...groups.keys()][0]??'';
    worldSelect.value=selectedWorldId;populateRepresentations();
    if(previousWorldId!==selectedWorldId||previousRepresentationId!==selectedRepresentationId)clearCaptures();
    const world=currentWorld();
    if(!world){viewport.clearScene();loadedRepresentationId='';sampled=null;sourceOutput.textContent='';clearCaptures();status.textContent='No generated world representations in this workspace';return;}
    if(loadedRepresentationId!==world.id)await installRepresentation(world,id,signal);
    else status.textContent=`${representationLabel(world)} · ${viewName} view ready`;
  });}

for(const name of Object.keys(poses) as PoseName[]){const button=document.createElement('button');button.type='button';button.textContent=name;button.dataset.view=name;button.setAttribute('aria-pressed',String(name===viewName));button.disabled=true;button.addEventListener('click',()=>{void changeView(name);});element('views').append(button);}
worldSelect.addEventListener('change',()=>{selectedWorldId=worldSelect.value;selectedRepresentationId='';populateRepresentations();clearCaptures();void changeRepresentation();});
representationSelect.addEventListener('change',()=>{selectedRepresentationId=representationSelect.value;void changeRepresentation();});
refreshButton.addEventListener('click',()=>{void refreshWorlds();});captureButton.addEventListener('click',()=>{void captureAll();});
cancelButton.addEventListener('click',()=>{cancelled=true;currentAbort?.abort();viewport.clearScene();loadedRepresentationId='';cancelButton.disabled=true;status.textContent='Cancelling…';});
manifestButton.addEventListener('click',()=>{const record={schemaVersion:1,batchStartedAt,comparison:selectedWorldId.startsWith('reference:')?'authored geometry control, not a model output':'source-space, metric alignment unreviewed',worldId:selectedWorldId,
  captures:captures.map(({url,sha256,...capture})=>({...capture,sourceAssetSha256:sha256})),models:[{name:'Atlas',state:'not-run'},{name:'GenRecon',state:'not-run'},{name:'WorldSculpt',state:'not-run'}]};
  const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'}));objectUrls.add(url);const link=document.createElement('a');link.href=url;link.download='world-comparison.json';link.click();
});
function dispose(){if(disposed)return;disposed=true;++request;currentAbort?.abort();viewport.dispose();for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.clear();}
window.addEventListener('pagehide',dispose,{once:true});
async function start(){setBusy(true);try{const bootstrap=await api('/api/bootstrap');baseScene=bootstrap.project.scene;selectedWorldId=query.get('world')??'';selectedRepresentationId=query.get('representation')??'';}
  catch(error){showError(error instanceof Error?error.message:String(error));status.textContent='A connected local workspace is required';setBusy(false);return;}
  setBusy(false);await refreshWorlds();
}
void start();
