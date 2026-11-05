/** Conservative GPU-resource boundary. Unknown fields remain in the key: new
 * scene features cannot silently inherit an incomplete incremental adapter. */
const materialValues = ['name','baseColor','roughness','metallic','transmission','ior','normalScale','heightScaleM','textureRepeat'];
const lightValues = ['id','name','enabled','type','positionM','targetM','powerW','diameterM','color','coneDeg','blend'];
function remove(object:any, keys:readonly string[]) {if(object)for(const key of keys)delete object[key];}
function materialResource(material:any) {remove(material,materialValues);}
function copy(scene:any):any {return JSON.parse(JSON.stringify(scene));}

export function viewportAssetKey(scene:any):string {
  const value=copy(scene);
  remove(value,['postProcessing','shots','actions','motions']);
  remove(value.placement,['translationM','rotationYDegrees','scale','restsOn','contactPointM']);
  // Image content has GPU resources even though camera/timing do not.
  value.filmImages=(scene.shots??[]).filter((shot:any)=>shot.kind==='image').map((shot:any)=>({id:shot.id,image:shot.image}));
  remove(value.render,['width','height','fps','durationFrames','samples','seed']);
  for(const component of value.product?.components??[]){
    materialResource(component.material);
    remove(component.assembly,['translationM','rotationXyzw','scale']);
    for(const node of component.sourceNodes??[])remove(node,['localMatrix']);
  }
  for(const preset of value.product?.materialPresets??[])materialResource(preset.material);
  const environment=value.environment;
  remove(environment,['worldColor','floorY']);
  remove(environment?.plinth,['translationM','rotationXyzw','visible']);
  materialResource(environment?.plinth?.material);
  for(const prop of environment?.props??[]){
    remove(prop,['translationM','rotationXyzw','relationship']);
    materialResource(prop.material);
  }
  if(value.lighting){
    // Light topology is cheap and has its own lifecycle; HDRI bytes are not.
    const {hdri,lights,...lighting}=value.lighting;
    remove(lighting,['ambientStrength','ambientColor']);
    const resources=(lights??[]).flatMap((light:any)=>{const rest={...light};remove(rest,lightValues);return Object.keys(rest).length?[{id:light.id,...rest}]:[];});
    value.lighting={...lighting,...(resources.length?{lights:resources}:{}),...(hdri?{hdri:{...hdri,intensity:undefined,rotationDeg:undefined}}:{})};
  }else value.lighting={};
  return JSON.stringify(value);
}
export function materialPreviewResourceKey(preview:any):string {
  const material=copy(preview.material);materialResource(material);
  return JSON.stringify({targets:[...new Set(preview.componentIds)].sort(),preset:preview.presetId,material});
}
export function canUpdateViewportScene(previous:any,next:any):boolean {
  return !!previous&&!!next&&viewportAssetKey(previous)===viewportAssetKey(next);
}

/** Sampling uses physical transforms, motion and optics, not surface values.
 * Keep all other scene facts so a future sampler dependency defaults to resample. */
export function viewportSamplesKey(scene:any):string {
  const value=copy(scene);remove(value,['postProcessing']);
  for(const component of value.product?.components??[])delete component.material;
  for(const preset of value.product?.materialPresets??[])delete preset.material;
  remove(value.environment,['worldColor']);
  if(value.environment?.plinth)delete value.environment.plinth.material;
  for(const prop of value.environment?.props??[])delete prop.material;
  if(value.lighting){
    const {ambientStrength,ambientColor,hdri,...lighting}=value.lighting;
    value.lighting={...lighting,lights:(lighting.lights??[]).map((light:any)=>{const pose={...light};remove(pose,['name','type','powerW','diameterM','color','coneDeg','blend']);return pose;})};
  }
  return JSON.stringify(value);
}
export function canReuseViewportSamples(previous:any,next:any):boolean {
  return !!previous&&!!next&&viewportSamplesKey(previous)===viewportSamplesKey(next);
}
