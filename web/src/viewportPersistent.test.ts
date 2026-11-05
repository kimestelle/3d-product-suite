import {createHash} from 'node:crypto';
import * as THREE from 'three';
import {describe,it,expect,vi,afterEach} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {StudioViewport} from './viewport';
import {filmGateRect} from './filmGuides';

function texture(seed=0){const bytes=new ArrayBuffer(33),h=new DataView(bytes);h.setUint32(0,0x89504e47);h.setUint32(4,0x0d0a1a0a);h.setUint32(8,13);h.setUint32(12,0x49484452);h.setUint32(16,2);h.setUint32(20,2);h.setUint8(32,seed);const sha256=createHash('sha256').update(new Uint8Array(bytes)).digest('hex');return {bytes,asset:{path:`assets/${sha256}.png`,sha256,format:'png'}};}
function glb(){
  const positions=new Float32Array([-.01,-.02,-.003,.01,-.02,.003,0,.02,0]);
  const document={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Assembly',children:[1,2]},{name:'Shell',mesh:0},{name:'Base',mesh:0}],
    meshes:[{primitives:[{attributes:{POSITION:0},material:0}]}],materials:[{name:'Native red',pbrMetallicRoughness:{baseColorFactor:[.8,.1,.05,1],roughnessFactor:.2,metallicFactor:.3}}],
    buffers:[{byteLength:positions.byteLength}],bufferViews:[{buffer:0,byteLength:positions.byteLength}],accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[-.01,-.02,-.003],max:[.01,.02,.003]}]};
  const json=new TextEncoder().encode(JSON.stringify(document)),length=Math.ceil(json.length/4)*4,bytes=new ArrayBuffer(28+length+positions.byteLength),h=new DataView(bytes);
  h.setUint32(0,0x46546c67,true);h.setUint32(4,2,true);h.setUint32(8,bytes.byteLength,true);h.setUint32(12,length,true);h.setUint32(16,0x4e4f534a,true);
  new Uint8Array(bytes,20,length).fill(32);new Uint8Array(bytes,20,json.length).set(json);h.setUint32(20+length,positions.byteLength,true);h.setUint32(24+length,0x004e4942,true);new Uint8Array(bytes,28+length).set(new Uint8Array(positions.buffer));
  const sha256=createHash('sha256').update(new Uint8Array(bytes)).digest('hex');return {bytes,asset:{path:`assets/${sha256}.glb`,sha256,format:'glb',sourceUp:'Y'}};
}
function source():any {
  const scene:any=structuredClone(fixture);delete scene.product.label;scene.product.components=[scene.product.components[0]];
  scene.environment.studioSizeM=.32;scene.environment.plinth.material={baseColor:[.4,.3,.2,1],roughness:.4,metallic:0};
  scene.lighting={ambientStrength:.3,lights:[{id:'key',name:'Key',enabled:true,type:'area',powerW:3,color:[1,1,1],positionM:[0,.4,.3],targetM:[0,.1,0],diameterM:.1}]};
  return scene;
}
function sample(scene:any):any {return {frame:1,components:Object.fromEntries(scene.product.components.map((c:any)=>[c.id,{translationM:scene.placement.translationM,rotationXyzw:c.assembly.rotationXyzw,scale:scene.placement.scale??1}])),camera:{...scene.shots[0].camera.from},removedPartIds:[]};}
function view(){
  const viewport=Object.create(StudioViewport.prototype) as any,content=new THREE.Group(),scene=new THREE.Scene();scene.add(content);
  Object.assign(viewport,{canvas:{style:{},clientWidth:800,clientHeight:500},camera:new THREE.PerspectiveCamera(40,1.6,.001,100),scene,content,
    renderer:{capabilities:{getMaxAnisotropy:()=>8}},options:{studioMode:true,onLoading:vi.fn(),onParts:vi.fn()},
    components:new Map(),parts:new Map(),originalVisibility:new Map(),environmentObjects:new Map(),focusMaterials:new Map(),previewMaterials:new Set(),hiddenParts:new Set(),focusPartIds:[],
    surfaceSpecifications:new WeakMap(),lightingObjects:new Set(),lightingRigOrigin:null,studioLights:new Map(),sceneProps:new Map(),
    loadVersion:0,frameRequest:0,frameQueue:Promise.resolve(),liveRender:null,disposed:false,loading:false,loadFailed:false,awaitingSample:false,
    controls:null,selection:null,productPreview:false,productGround:null,selectedId:null,inspectingCamera:false,framedSelection:false,partFocus:false,
    pendingSize:null,materialPreviewState:null,presentationVersion:0,sceneUpdateRequest:0,visible:false});
  vi.spyOn(viewport,'invalidate').mockImplementation(()=>{});vi.spyOn(viewport,'scheduleRender').mockImplementation(()=>{});
  vi.stubGlobal('document',{hidden:true,fonts:{load:vi.fn(async()=>[])}});vi.stubGlobal('cancelAnimationFrame',vi.fn());
  return viewport;
}
async function open(v:any,s:any){await v.load(s,undefined,sample(s));await v.frame(sample(s));}
async function present(v:any){
  vi.spyOn(v,'canDraw').mockReturnValue(true);vi.spyOn(v,'setDrawingBuffer').mockImplementation(()=>{});vi.spyOn(v,'drawScenePixels').mockImplementation(()=>{});
  await v.draw(false,v.loadVersion);
}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('persistent real Three scene',()=>{
  it('keeps geometry, maps, studio and selected camera through finish/light/lens/placement edits',async()=>{
    const tex=texture(),s=source();s.product.components[0].material.textures={normal:tex.asset};
    const fetch=vi.fn(async()=>new Response(tex.bytes));vi.stubGlobal('fetch',fetch);vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:2,height:2,close:vi.fn()})));
    const v=view();await open(v,s);v.setSelection('bottle-body');v.inspectingCamera=true;v.camera.position.set(.3,.4,.5);v.camera.lookAt(0,.1,0);
    const camera=v.camera.position.clone(),root=v.components.get('bottle-body'),mesh=root.children[0],geometry=mesh.geometry,map=mesh.material.normalMap,material=mesh.material;
    const ground=v.productGround,sweep=v.content.getObjectByName('Authored environment sweep'),light=v.studioLights.get('key').light;
    const disposed=vi.spyOn(geometry,'dispose'),cleared=vi.spyOn(v,'clearContent');v.options.onLoading.mockClear();
    for(let i=0;i<12;i++){
      s.product.components[0].material.roughness=.1+i*.02;s.lighting.lights[0].powerW=4+i;s.lighting.lights[0].positionM[0]=i*.01;
      s.shots[0].camera.from.focalLengthMm=50+i;s.placement.scale=1+i*.01;await open(v,s);
      expect(v.components.get('bottle-body')).toBe(root);expect(mesh.material).toBe(material);expect(mesh.geometry).toBe(geometry);expect(mesh.material.normalMap).toBe(map);
      expect(v.productGround).toBe(ground);expect(v.content.getObjectByName('Authored environment sweep')).toBe(sweep);expect(v.studioLights.get('key').light).toBe(light);
      expect(v.selectedId).toBe('bottle-body');expect(v.camera.position.distanceTo(camera)).toBeLessThan(1e-10);
    }
    expect(fetch).toHaveBeenCalledOnce();expect(createImageBitmap).toHaveBeenCalledOnce();expect(disposed).not.toHaveBeenCalled();expect(cleared).not.toHaveBeenCalled();expect(v.options.onLoading).not.toHaveBeenCalled();
    expect(material.roughness).toBeCloseTo(.32);expect(light.intensity).toBeCloseTo(15/(Math.PI*light.width*light.height));
    expect(v.sampledCamera.fov).toBeCloseTo(THREE.MathUtils.radToDeg(2*Math.atan(18/61)));
    expect(v.options.onParts.mock.calls.at(-1)[0][0].dimensionsM[0]).toBeCloseTo(s.product.components[0].sizeM[0]*1.11);
  });
  it('replaces only a light rig topology while preserving the product and contact receiver',async()=>{
    const s=source(),v=view();await open(v,s);const root=v.components.get('bottle-body'),ground=v.productGround,oldLight=v.studioLights.get('key').light;
    s.lighting.lights[0].type='spot';s.lighting.lights[0].coneDeg=35;await open(v,s);
    expect(v.components.get('bottle-body')).toBe(root);expect(v.productGround).toBe(ground);expect(oldLight.parent).toBeNull();
    expect(v.studioLights.get('key').light).toBeInstanceOf(THREE.SpotLight);
    s.lighting.lights[0].enabled=false;await open(v,s);expect(v.studioLights.size).toBe(0);expect(v.components.get('bottle-body')).toBe(root);
  });
  it('keeps the floor, support, background and inspection contact cue aligned',async()=>{
    const s=source(),v=view();await open(v,s);const floor=v.content.getObjectByName('Authored environment sweep'),ground=v.productGround,origin=ground.position.clone();
    s.environment.floorY=.2;s.environment.worldColor=[.1,.2,.3];s.environment.plinth.translationM[0]=.12;s.environment.plinth.visible=false;s.placement.scale=2;await open(v,s);
    expect(v.productGround).toBe(ground);expect(ground.position.x-origin.x).toBeCloseTo(.12);expect(floor.position.y).toBeCloseTo(.2-(fixture.environment.plinth.translationM[1]-fixture.environment.plinth.sizeM[1]/2));
    expect(v.environmentBackground.toArray()).toEqual([.1,.2,.3]);expect(floor.material.color.toArray()).toEqual([.1,.2,.3]);
    expect(v.content.getObjectByName('Explicit contact plinth').visible).toBe(false);expect(ground.userData.gessoContactShadow.radius.value).toBeCloseTo(Math.max(s.product.dimensionsM[0],s.product.dimensionsM[2])*2*.9);
  });
  it('rebuilds actual geometry on topology changes and releases the old allocation',async()=>{
    const s=source(),v=view();await open(v,s);const root=v.components.get('bottle-body'),geometry=root.children[0].geometry,disposed=vi.spyOn(geometry,'dispose');
    s.product.components[0].sizeM[0]*=2;await open(v,s);expect(v.components.get('bottle-body')).not.toBe(root);expect(disposed).toHaveBeenCalledOnce();
  });
  it('coalesces queued revisions so an obsolete edit cannot overwrite the latest scene',async()=>{
    const s=source(),v=view();await open(v,s);const material=v.components.get('bottle-body').children[0].material;
    let release!:()=>void;v.frameQueue=new Promise<void>(resolve=>{release=resolve;});
    const a=structuredClone(s),b=structuredClone(s);a.product.components[0].material.roughness=.2;b.product.components[0].material.roughness=.7;
    const first=v.load(a,undefined,sample(a)),second=v.load(b,undefined,sample(b));release();await Promise.all([first,second]);
    expect(material.roughness).toBe(.7);expect(v.loadedSource).toEqual(b);
  });
  it.each(['queued','applied'])('replays an undo plus grading over a %s optimistic finish edit',async(state)=>{
    const original=source(),v=view();await open(v,original);const root=v.components.get('bottle-body'),material=root.children[0].material;
    const changed=structuredClone(original),restored=structuredClone(original);changed.product.components[0].material.roughness=.81;restored.postProcessing={enabled:true,exposureEV:.5};
    let release=()=>{};
    if(state==='queued')v.frameQueue=new Promise<void>(resolve=>{release=resolve;});
    const obsolete=v.load(changed,undefined,sample(changed));if(state==='applied')await obsolete;
    const latest=v.load(restored,undefined,sample(restored));release();await Promise.all([obsolete,latest]);await v.frame(sample(restored));
    expect(v.components.get('bottle-body')).toBe(root);expect(root.children[0].material).toBe(material);
    expect(material.roughness).toBe(original.product.components[0].material.roughness);expect(v.imageFinish.exposureEV).toBe(.5);
    expect(v.loadedSource.product.components[0].material.roughness).toBe(original.product.components[0].material.roughness);
  });
  it('cannot publish a queued value edit after a newer structural replacement',async()=>{
    const s=source(),v=view();await open(v,s);let release!:()=>void;v.frameQueue=new Promise<void>(resolve=>{release=resolve;});
    const old=structuredClone(s),replacement=structuredClone(s);old.product.components[0].material.roughness=.2;replacement.product.components[0].sizeM[0]*=2;replacement.product.components[0].material.roughness=.8;
    const stale=v.load(old,undefined,sample(old)),latest=v.load(replacement,undefined,sample(replacement));release();await Promise.all([stale,latest]);await v.frame(sample(replacement));
    expect(v.components.get('bottle-body').children[0].material.roughness).toBe(.8);expect(v.loadedSource).toEqual(replacement);
  });
  it('updates a bound imported section through focus without changing native siblings or source slots',async()=>{
    const file=glb(),s=source(),component=s.product.components[0];component.shape='mesh';component.asset=file.asset;component.materialOverride=false;
    component.materialBindings=[{nodeIndex:1,materialPresetId:'steel'}];s.product.materialPresets=[{id:'steel',material:{baseColor:[.5,.5,.5,1],roughness:.1,metallic:1}}];
    const fetch=vi.fn(async()=>new Response(file.bytes));vi.stubGlobal('fetch',fetch);const v=view();await open(v,s);
    const shell=v.parts.get('bottle-body::node:1'),base=v.parts.get('bottle-body::node:2'),material=shell.material,native=base.material,geometry=shell.geometry;
    v.setFocusParts(['bottle-body::node:1']);s.product.materialPresets[0].material.roughness=.6;s.product.materialPresets[0].material.baseColor=[.2,.4,.8,1];await open(v,s);v.setFocusParts([]);
    expect(shell.material).toBe(material);expect(shell.geometry).toBe(geometry);expect(material.roughness).toBe(.6);expect(material.color.toArray()).toEqual([.2,.4,.8]);
    expect(base.material).toBe(native);expect(native.color.toArray()).toEqual([.8,.1,.05]);expect(material.userData.gessoSourceMaterial).toBe(0);expect(material.userData.gessoSourceMaterialName).toBe('Native red');expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains decoded draft maps across value changes, and restores authored material on cancel',async()=>{
    const tex=texture(),s=source(),v=view();await open(v,s);const mesh=v.components.get('bottle-body').children[0],original=mesh.material;
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(tex.bytes)));vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:2,height:2,close:vi.fn()})));
    const draft={componentIds:['bottle-body'],material:{...s.product.components[0].material,textures:{normal:tex.asset}}};
    await v.setMaterialPreview(draft);const material=mesh.material,map=material.normalMap;
    for(let i=0;i<10;i++)await v.setMaterialPreview({...draft,material:{...draft.material,roughness:.1+i*.04,baseColor:[.2,.1+i*.03,.3,1],textureRepeat:[2,3]}});
    expect(mesh.material).toBe(material);expect(material.normalMap).toBe(map);expect(map.repeat.toArray()).toEqual([2,3]);expect(fetch).toHaveBeenCalledOnce();expect(createImageBitmap).toHaveBeenCalledOnce();
    await v.setMaterialPreview(null);expect(mesh.material).toBe(original);
  });
});

describe('native proof optical view',()=>{
  it.each([false,true])('matches the actual %s film gate projection without changing inspection state',async(guides)=>{
    const s=source(),v=view();await open(v,s);v.pendingSize={width:1000,height:600};v.camera.aspect=1000/600;v.filmGuides=guides;v.filmOutputAspect=9/16;
    v.camera.position.set(.3,.2,.5);v.camera.lookAt(0,.1,0);v.inspectingCamera=true;v.sampledOptics={enabled:true,fStop:4,focusDistanceM:.48};v.applyFilmProjection(v.camera,v.pendingSize);
    v.camera.updateMatrixWorld(true);const before=v.camera.matrixWorld.clone();await present(v);const proof=v.getProofView();expect(proof.inspection).toBe(true);expect(proof.depthOfField).toEqual(v.sampledOptics);
    const native=new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2*Math.atan(18/proof.focalLengthMm)),proof.aspect,.001,100);native.position.fromArray(proof.positionM);native.lookAt(new THREE.Vector3().fromArray(proof.targetM));native.updateMatrixWorld();
    const gate=guides?filmGateRect(1000,600,9/16):{x:0,y:0,width:1000,height:600};v.camera.updateMatrixWorld();
    for(const point of [[0,.1,0],[.02,.12,.01],[-.01,.08,-.02]]){
      const browser=new THREE.Vector3().fromArray(point).project(v.camera),actual=new THREE.Vector3().fromArray(point).project(native);
      const x=((browser.x+1)*500-gate.x)/gate.width*2-1,y=1-((1-browser.y)*300-gate.y)/gate.height*2;
      expect(actual.x).toBeCloseTo(x,10);expect(actual.y).toBeCloseTo(y,10);
    }
    expect(v.camera.matrixWorld.equals(before)).toBe(true);
  });
  it('refuses product inspection, image clips, unsampled replacements and unavailable views',async()=>{
    const v=view(),s=source();await open(v,s);v.pendingSize={width:800,height:500};expect(v.getProofView()).toBeNull();await present(v);expect(v.getProofView()).not.toBeNull();
    v.productPreview=true;expect(v.getProofView()).toBeNull();v.productPreview=false;v.filmClip={kind:'image'};expect(v.getProofView()).toBeNull();v.filmClip={kind:'scene'};v.awaitingSample=true;expect(v.getProofView()).toBeNull();
  });
  it('reports the last displayed optical pose, permits identical retries and rejects undrawn source changes',async()=>{
    const v=view(),s=source();await open(v,s);v.pendingSize={width:800,height:500};v.inspectingCamera=true;await present(v);const shown=v.getProofView();
    v.camera.position.x+=.1;v.sampledOptics={enabled:true,fStop:8,focusDistanceM:.4};expect(v.getProofView()).toEqual(shown);
    await v.load(s,undefined,sample(s));await v.frame(sample(s));expect(v.getProofView()).toEqual(shown);
    const changed=structuredClone(s);changed.product.components[0].material.roughness=.23;await open(v,changed);expect(v.getProofView()).toBeNull();
    await present(v);expect(v.getProofView().positionM[0]).toBeCloseTo(shown.positionM[0]+.1);
    const next=sample(changed);next.frame=2;await v.frame(next);expect(v.getProofView()).toBeNull();
  });
});
