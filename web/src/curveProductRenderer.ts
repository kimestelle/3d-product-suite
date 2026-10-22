import * as THREE from 'three';
import {disposeSceneObject} from './sceneObjects';
import {DEFAULT_PRODUCT_SETTINGS,normalizeProductSettings,type ProductViewSettings} from './curveProductSettings';

export type CurveProductSettings=ProductViewSettings;
export const normalizeCurveProductSettings=normalizeProductSettings;
/** Degrees, matching the specimen's native range controls. */
export type CurveProductRotation={yaw:number;pitch:number};
export const CURVE_PRODUCT_BUFFER={width:750,height:450} as const;
const clamp=(value:number,min:number,max:number,fallback:number)=>Number.isFinite(value)?Math.max(min,Math.min(max,value)):fallback;
export function normalizeCurveProductRotation(rotation:CurveProductRotation):CurveProductRotation {
  return {yaw:Number.isFinite(rotation.yaw)?((rotation.yaw%360)+360)%360:0,pitch:clamp(rotation.pitch,-80,80,0)};
}

/** Owns the verified product and reuses its buffers for fill and triangle edges.
 * The outer groups normalize the inspection stage without rewriting CAD nodes. */
export function prepareCurveProductObject(root:THREE.Group){
  const sourceMeshes:THREE.Mesh[]=[];
  root.traverse(object=>{if(object instanceof THREE.Mesh)sourceMeshes.push(object);});
  if(!sourceMeshes.length)throw new Error('The product has no mesh surfaces.');
  if(sourceMeshes.some(mesh=>mesh instanceof THREE.SkinnedMesh))throw new Error('This study does not yet support skinned product meshes.');
  if(sourceMeshes.some(mesh=>mesh instanceof THREE.InstancedMesh||mesh instanceof THREE.BatchedMesh))
    throw new Error('This study does not yet support instanced product meshes.');
  if(sourceMeshes.some(mesh=>Object.values(mesh.geometry.morphAttributes).some(attributes=>attributes.length>0)))
    throw new Error('This study does not yet support product morph targets.');
  root.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(root),size=bounds.getSize(new THREE.Vector3());
  if(bounds.isEmpty()||!Number.isFinite(size.length())||size.y<=0)throw new Error('The product has no measurable height.');
  const center=bounds.getCenter(new THREE.Vector3()),placement=new THREE.Group(),group=new THREE.Group();
  placement.position.copy(center).negate();group.scale.setScalar(1/size.y);
  const fillMaterials=new Map<THREE.Material,THREE.Material>();
  const wireMaterial=new THREE.MeshBasicMaterial({color:'#292421',wireframe:true,transparent:true,opacity:DEFAULT_PRODUCT_SETTINGS.edges,
    depthWrite:false,depthTest:true,side:THREE.DoubleSide,toneMapped:false});
  const depthMaterial=new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:true,depthTest:true,
    side:THREE.FrontSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
  const fill=(original:THREE.Material)=>{
    let result=fillMaterials.get(original);
    if(!result){
      result=original.clone();result.transparent=true;result.depthWrite=false;result.side=THREE.DoubleSide;
      result.forceSinglePass=true;result.polygonOffset=true;result.polygonOffsetFactor=1;result.polygonOffsetUnits=1;
      fillMaterials.set(original,result);
    }
    return result;
  };
  let records:{mesh:THREE.Mesh;original:THREE.Material|THREE.Material[];material:THREE.Material|THREE.Material[];renderOrder:number;wire:THREE.Mesh;depth:THREE.Mesh}[];
  try{records=sourceMeshes.map(mesh=>{
    const original=mesh.material,renderOrder=mesh.renderOrder;
    const material=Array.isArray(original)?original.map(fill):fill(original);
    const wire=new THREE.Mesh(mesh.geometry,wireMaterial),depth=new THREE.Mesh(mesh.geometry,depthMaterial);
    // Child meshes inherit every imported local/source transform. No positions
    // are duplicated and neither overlay participates in the product hierarchy.
    wire.name='Inspection triangle edges';depth.name='Inspection depth';
    wire.renderOrder=3;depth.renderOrder=0;wire.visible=false;depth.visible=false;
    wire.frustumCulled=mesh.frustumCulled;depth.frustumCulled=mesh.frustumCulled;
    return {mesh,original,material,renderOrder,wire,depth};
  });}catch(error){
    // The caller retains the unchanged root if material preparation fails.
    fillMaterials.forEach(material=>material.dispose());wireMaterial.dispose();depthMaterial.dispose();throw error;
  }
  for(const record of records)record.mesh.add(record.wire,record.depth);
  placement.add(root);group.add(placement);
  let disposed=false;
  return {group,sourceMeshes,
    apply(input:CurveProductSettings,rotation:CurveProductRotation){
      if(disposed)throw new Error('The product study has been disposed.');
      const settings=normalizeCurveProductSettings(input),angle=normalizeCurveProductRotation(rotation);
      group.rotation.set(THREE.MathUtils.degToRad(angle.pitch),THREE.MathUtils.degToRad(angle.yaw),0,'YXZ');
      for(const material of fillMaterials.values()){
        material.opacity=settings.opacity;material.visible=settings.opacity>0;
      }
      wireMaterial.opacity=settings.edges;wireMaterial.depthTest=!settings.backEdges;
      for(const record of records){
        const solid=settings.mode==='solid',wire=settings.mode==='wireframe'&&settings.edges>0;
        record.mesh.material=solid?record.original:record.material;
        record.mesh.renderOrder=solid?record.renderOrder:1;
        record.wire.visible=wire;
        // At zero fill opacity, front-only edges still need a depth surface.
        // Back edges deliberately reveal occluded triangles, not inferred parts.
        record.depth.visible=wire&&!settings.backEdges;
      }
      group.updateMatrixWorld(true);
    },
    dispose(){
      if(disposed)return;disposed=true;
      for(const record of records){record.mesh.material=record.original;record.mesh.renderOrder=record.renderOrder;}
      disposeSceneObject(root);fillMaterials.forEach(material=>material.dispose());
      group.removeFromParent();group.clear();
    },
  };
}

/** One low-resolution WebGL buffer serves every comparison frame on demand.
 * Morphing the SVG boundary does not draw or reload the product. */
export class CurveProductRenderer{
  private readonly renderer:THREE.WebGLRenderer;
  private readonly scene=new THREE.Scene();
  private readonly camera=new THREE.OrthographicCamera(-1000/220/2,1000/220/2,600/220/2,-600/220/2,.01,30);
  private readonly product:ReturnType<typeof prepareCurveProductObject>;
  private disposed=false;
  private lost=false;
  private readonly contextLost:(event:Event)=>void;

  constructor(root:THREE.Group,onContextLost?:()=>void){
    // If context allocation fails, the caller still owns the unmodified root.
    const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power',preserveDrawingBuffer:false});
    this.renderer=renderer;
    this.contextLost=(event:Event)=>{event.preventDefault();if(this.disposed)return;this.lost=true;onContextLost?.();};
    try{
      renderer.setPixelRatio(1);renderer.setSize(CURVE_PRODUCT_BUFFER.width,CURVE_PRODUCT_BUFFER.height,false);
      renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
      this.scene.background=new THREE.Color('#ecece7');
      const key=new THREE.DirectionalLight(0xffffff,3.4);key.position.set(-3,5,6);
      const fill=new THREE.DirectionalLight(0xffffff,1.5);fill.position.set(4,1,2);
      const rim=new THREE.DirectionalLight(0xffffff,2);rim.position.set(1,3,-4);
      this.scene.add(key,fill,rim,new THREE.HemisphereLight(0xffffff,0xbdbbb4,2.3));
      this.camera.position.set(0,1.4,7);this.camera.lookAt(0,0,0);this.camera.updateMatrixWorld();
      renderer.domElement.addEventListener('webglcontextlost',this.contextLost);
      // Configure GL before taking ownership. Failed preparation leaves the
      // caller's root intact and releases only its temporary inspection materials.
      this.product=prepareCurveProductObject(root);
    }catch(error){
      renderer.domElement.removeEventListener('webglcontextlost',this.contextLost);
      this.scene.traverse(object=>{if(object instanceof THREE.DirectionalLight)object.shadow.dispose();});
      this.scene.clear();renderer.dispose();renderer.forceContextLoss();throw error;
    }
    this.scene.add(this.product.group);
  }

  draw(canvas:HTMLCanvasElement,settings:CurveProductSettings,rotation:CurveProductRotation):void{
    if(this.disposed)throw new Error('The product study has been disposed.');
    if(this.lost||this.renderer.getContext().isContextLost())throw new Error('The product preview lost its graphics context. Retry to reopen it.');
    const context=canvas.getContext('2d',{alpha:false});
    if(!context)throw new Error('The product preview could not open its image buffer.');
    this.product.apply(settings,rotation);
    this.renderer.render(this.scene,this.camera);
    if(canvas.width!==CURVE_PRODUCT_BUFFER.width)canvas.width=CURVE_PRODUCT_BUFFER.width;
    if(canvas.height!==CURVE_PRODUCT_BUFFER.height)canvas.height=CURVE_PRODUCT_BUFFER.height;
    // Copy in the same task, before the browser clears the transient GL buffer.
    context.drawImage(this.renderer.domElement,0,0);
  }

  dispose():void{
    if(this.disposed)return;this.disposed=true;
    this.renderer.domElement.removeEventListener('webglcontextlost',this.contextLost);
    this.product.dispose();
    this.scene.traverse(object=>{if(object instanceof THREE.DirectionalLight)object.shadow.dispose();});
    this.scene.clear();this.renderer.dispose();this.renderer.forceContextLoss();
  }
}
