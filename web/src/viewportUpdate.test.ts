import {describe,it,expect} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {canUpdateViewportScene,canReuseViewportSamples,viewportAssetKey,materialPreviewResourceKey} from './viewportUpdate';

function source():any {const value:any=structuredClone(fixture);value.lighting={ambientStrength:.3,lights:[{id:'key',type:'area',enabled:true,powerW:3,color:[1,1,1],positionM:[0,.4,.3],targetM:[0,.1,0],diameterM:.1}]};return value;}
describe('persistent scene dependencies',()=>{
  it.each([
    ['finish',(s:any)=>{s.product.components[0].material.roughness=.4;}],
    ['light',(s:any)=>{s.lighting.lights[0].positionM[0]=.5;}],
    ['light power',(s:any)=>{s.lighting.lights[0].powerW=10;}],
    ['light topology',(s:any)=>{s.lighting.lights.push({...s.lighting.lights[0],id:'second',type:'spot'});}],
    ['camera',(s:any)=>{s.shots[0].camera.from.focalLengthMm=80;}],
    ['placement',(s:any)=>{s.placement.scale=2;}],
    ['floor',(s:any)=>{s.environment.floorY=.2;}],
    ['support visibility',(s:any)=>{s.environment.plinth.visible=false;}],
    ['film timing',(s:any)=>{s.shots[0].endFrame=90;}],
    ['world colour',(s:any)=>{s.environment.worldColor=[.4,.2,.1];}],
  ])('retains resource identity for %s',(_name,edit)=>{
    const before=source(),after=structuredClone(before),untouched=structuredClone(before);edit(after);
    expect(canUpdateViewportScene(before,after)).toBe(true);expect(before).toEqual(untouched);
  });
  it.each([
    ['geometry',(s:any)=>{s.product.components[0].sizeM[0]*=2;}],
    ['map',(s:any)=>{s.product.components[0].material.textures={basecolor:{sha256:'new-map'}};}],
    ['binding',(s:any)=>{s.product.components[0].materialBindings=[{nodeIndex:0,materialPresetId:'new'}];}],
    ['artwork',(s:any)=>{s.product.artwork=[{partId:'bottle-body',asset:{sha256:'new'}}];}],
    ['world asset',(s:any)=>{s.environment.asset={sha256:'new'};}],
    ['unknown property',(s:any)=>{s.product.components[0].newGeometryFeature=true;}],
    ['unknown placement property',(s:any)=>{s.placement.newDeformation=true;}],
    ['unknown light resource',(s:any)=>{s.lighting.lights[0].projectorAsset={sha256:'new'};}],
    ['image clip',(s:any)=>{s.shots.push({id:'image',kind:'image',image:{asset:{sha256:'image'}}});}],
  ])('rebuilds on %s',(_name,edit)=>{const before=source(),after=structuredClone(before);edit(after);expect(canUpdateViewportScene(before,after)).toBe(false);});
  it('distinguishes sample dependencies from GPU resources',()=>{
    const before=source(),colour=structuredClone(before);colour.product.components[0].material.baseColor=[.3,.2,.1,1];colour.lighting.lights[0].powerW=20;
    expect(canReuseViewportSamples(before,colour)).toBe(true);
    const position=structuredClone(colour);position.lighting.lights[0].positionM[0]=.2;
    expect(canReuseViewportSamples(colour,position)).toBe(false);expect(viewportAssetKey(colour)).toBe(viewportAssetKey(position));
    const future=structuredClone(position);future.lighting.lights[0].newMotionParameter=2;expect(canReuseViewportSamples(position,future)).toBe(false);
  });
  it('keeps map/target identity independent of material-draft values',()=>{
    const a={componentIds:['one','two'],material:{baseColor:[1,0,0,1],roughness:.1,metallic:1,textures:{normal:{sha256:'same'}}}};
    expect(materialPreviewResourceKey(a)).toBe(materialPreviewResourceKey({...a,componentIds:['two','one'],material:{...a.material,roughness:.8}}));
    expect(materialPreviewResourceKey(a)).not.toBe(materialPreviewResourceKey({...a,componentIds:['one']}));
  });
});
