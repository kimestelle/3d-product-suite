import * as THREE from 'three';

/** Reuses the loaded product's buffers. The outline never owns source geometry. */
export function createModelOutline(components: Map<string, THREE.Group>, parts: Map<string, THREE.Object3D>, removed: Set<string>) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#242424');
  const camera = new THREE.OrthographicCamera();
  const wire = new THREE.MeshBasicMaterial({color:'#bac1c7',wireframe:true,transparent:true,opacity:.06,depthTest:false,depthWrite:false,toneMapped:false});
  const activeWire = new THREE.MeshBasicMaterial({color:'#ffffff',wireframe:true,transparent:true,opacity:.48,depthTest:false,depthWrite:false,toneMapped:false});
  const face = new THREE.MeshBasicMaterial({color:'#d7e4ec',transparent:true,opacity:.48,side:THREE.DoubleSide,depthTest:false,depthWrite:false,toneMapped:false});
  const sourceIds = new Map<THREE.Object3D, string>();
  parts.forEach((object,id)=>sourceIds.set(object,id));
  const excluded = new Set<THREE.Object3D>();
  for (const id of removed) parts.get(id)?.traverse(object=>excluded.add(object));
  const entries: {source:THREE.Mesh; line:THREE.Mesh; fill:THREE.Mesh; ids:string[]}[] = [];
  for (const root of components.values()) {
    root.updateWorldMatrix(true,true);
    root.traverse(object=>{
      if (!(object instanceof THREE.Mesh) || !object.geometry.getAttribute('position') || excluded.has(object)) return;
      const ids:string[]=[];
      let parent:THREE.Object3D|null=object;
      while(parent) {
        if(parent.userData.gessoArtwork || parent.userData.gessoDecal) return;
        const id=sourceIds.get(parent);if(id)ids.push(id);
        parent=parent.parent;
      }
      const line=new THREE.Mesh(object.geometry,wire), fill=new THREE.Mesh(object.geometry,face);
      line.matrixAutoUpdate=fill.matrixAutoUpdate=false;
      line.matrix.copy(object.matrixWorld);fill.matrix.copy(object.matrixWorld);
      fill.visible=false;fill.renderOrder=1;line.renderOrder=2;
      scene.add(fill,line);entries.push({source:object,line,fill,ids});
    });
  }
  const bounds=new THREE.Box3();
  for(const {source} of entries) {
    if(!source.geometry.boundingBox)source.geometry.computeBoundingBox();
    if(source.geometry.boundingBox)bounds.union(source.geometry.boundingBox.clone().applyMatrix4(source.matrixWorld));
  }
  if(!bounds.isEmpty()) {
    const sphere=bounds.getBoundingSphere(new THREE.Sphere()),radius=Math.max(sphere.radius,.0001);
    camera.near=radius*.01;camera.far=radius*12;
    camera.position.copy(sphere.center).add(new THREE.Vector3(.8,.45,1.5).normalize().multiplyScalar(radius*4));
    camera.lookAt(sphere.center);camera.updateMatrixWorld();
    const projected=new THREE.Box3(),corner=new THREE.Vector3();
    for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z])projected.expandByPoint(corner.set(x,y,z).applyMatrix4(camera.matrixWorldInverse));
    const size=projected.getSize(new THREE.Vector3());
    const halfHeight=Math.max(size.y,size.x/1.6)*.58;
    camera.left=-halfHeight*1.6;camera.right=halfHeight*1.6;camera.top=halfHeight;camera.bottom=-halfHeight;
    camera.updateProjectionMatrix();
  }
  return {
    scene,camera,empty:!entries.length,
    highlight(ids:string[]) {const active=new Set(ids);for(const entry of entries){const selected=entry.ids.some(id=>active.has(id));entry.fill.visible=selected;entry.line.material=selected?activeWire:wire;}},
    dispose(){scene.clear();wire.dispose();activeWire.dispose();face.dispose();},
  };
}

/** One small pass on the editor's renderer; no canvas resize or extra GL context. */
export function renderModelOutline(renderer:THREE.WebGLRenderer, outline:ReturnType<typeof createModelOutline>):HTMLCanvasElement {
  const width=320,height=200;
  const target=new THREE.WebGLRenderTarget(width,height,{depthBuffer:false});
  target.texture.colorSpace=THREE.SRGBColorSpace;
  const previousTarget=renderer.getRenderTarget(),cubeFace=renderer.getActiveCubeFace(),mipmapLevel=renderer.getActiveMipmapLevel();
  const autoClear=renderer.autoClear;
  const pixels=new Uint8Array(width*height*4);
  try {
    // Render targets carry physical-pixel viewports; setViewport would apply the live pixel ratio again.
    renderer.setRenderTarget(target);renderer.autoClear=true;
    renderer.render(outline.scene,outline.camera);
    renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
  } finally {
    renderer.setRenderTarget(previousTarget,cubeFace,mipmapLevel);renderer.autoClear=autoClear;target.dispose();
  }
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d');if(!context)throw new Error('Model outline is unavailable.');
  const image=context.createImageData(width,height);
  for(let y=0;y<height;y++)image.data.set(pixels.subarray((height-y-1)*width*4,(height-y)*width*4),y*width*4);
  context.putImageData(image,0,0);
  return canvas;
}
