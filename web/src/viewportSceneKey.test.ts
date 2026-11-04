import {describe,it,expect} from 'vitest';
import {viewportSceneKey,isImageFinishOnlyChange} from './viewportSceneKey';

function source():any {
  return {
    sceneId:'same-product',schemaVersion:1,
    product:{components:[{id:'body',asset:{path:'assets/product.glb',sha256:'product-v1'},material:{baseColor:[.2,.3,.4,1],roughness:.4,metallic:.2},materialOverride:false,
      assembly:{translationM:[0,.1,0],rotationXyzw:[0,0,0,1]},sourceNodes:[{nodeIndex:1,localMatrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}]}]},
    environment:{kind:'mesh',revisionId:'world-v1',asset:{path:'assets/room.glb',sha256:'room-v1'},previewQuality:'balanced',worldColor:[.2,.2,.2],rotationYDegrees:0,
      plinth:{id:'support',sizeM:[1,.1,1],translationM:[0,-.05,0]},props:[{id:'prop',translationM:[1,0,0],sizeM:[.2,.2,.2]}]},
    placement:{translationM:[0,0,0],scale:1,restsOn:'support'},
    lighting:{ambientStrength:.4,lights:[{id:'key',powerW:10,enabled:true,positionM:[0,1,1],color:[1,1,1]}],hdri:{asset:{path:'assets/sky.hdr'},intensity:1,rotationDeg:0}},
    shots:[{id:'one',startFrame:1,endFrame:120,camera:{from:{positionM:[0,.2,1],targetM:[0,.1,0],focalLengthMm:50},to:{positionM:[.1,.2,1],targetM:[0,.1,0],focalLengthMm:50}}}],
    render:{width:1080,height:1920,fps:24,durationFrames:120},motions:[],actions:[],
  };
}

describe('image-finish viewport reuse boundary',()=>{
  it('reuses sample and asset identity across enable, grade, spatial-effects and reset edits',()=>{
    const original=source(),before=structuredClone(original);
    const graded={...original,postProcessing:{enabled:true,exposureEV:.4,contrast:1.1,saturation:.8,temperature:.1,tint:-.05,highlights:-.2,shadows:.1,vignette:.3,grain:.025,bloom:.2}};
    const bypassed={...graded,postProcessing:{...graded.postProcessing,enabled:false}};
    expect(viewportSceneKey(graded)).toBe(viewportSceneKey(original));
    expect(isImageFinishOnlyChange(original,graded)).toBe(true);
    expect(isImageFinishOnlyChange(graded,bypassed)).toBe(true);
    expect(isImageFinishOnlyChange(bypassed,original)).toBe(true);
    expect(original).toEqual(before);
  });
  it.each([
    ['light power',(s:any)=>{s.lighting.lights[0].powerW=12;}],
    ['light position',(s:any)=>{s.lighting.lights[0].positionM[0]=.5;}],
    ['ambient light',(s:any)=>{s.lighting.ambientStrength=.8;}],
    ['HDRI',(s:any)=>{s.lighting.hdri.asset.path='assets/another.hdr';}],
    ['material',(s:any)=>{s.product.components[0].material.roughness=.8;}],
    ['material binding',(s:any)=>{s.product.components[0].materialBindings=[{materialIndex:0}];}],
    ['product geometry',(s:any)=>{s.product.components[0].asset.sha256='new-product';}],
    ['part transform',(s:any)=>{s.product.components[0].sourceNodes[0].localMatrix[12]=.01;}],
    ['world asset',(s:any)=>{s.environment.asset.path='assets/new-room.glb';}],
    ['world detail',(s:any)=>{s.environment.previewQuality='detail';}],
    ['world alignment',(s:any)=>{s.environment.rotationYDegrees=15;}],
    ['world color',(s:any)=>{s.environment.worldColor[1]=.4;}],
    ['prop position',(s:any)=>{s.environment.props[0].translationM[0]=2;}],
    ['product placement',(s:any)=>{s.placement.scale=2;}],
    ['camera position',(s:any)=>{s.shots[0].camera.from.positionM[0]=.3;}],
    ['camera lens',(s:any)=>{s.shots[0].camera.to.focalLengthMm=70;}],
    ['camera optics',(s:any)=>{s.shots[0].camera.depthOfField={enabled:true,fStop:2};}],
    ['camera interpolation',(s:any)=>{s.shots[0].camera.interpolation='linear';}],
    ['film timing',(s:any)=>{s.shots[0].endFrame=90;}],
    ['render dimensions',(s:any)=>{s.render.width=1920;}],
    ['render FPS',(s:any)=>{s.render.fps=30;}],
    ['animation',(s:any)=>{s.motions.push({id:'orbit',target:'$camera',enabled:true,amount:30});}],
    ['comparison world',(s:any)=>{s.comparison={b:{environment:{revisionId:'alternative'}}};}],
  ] as const)('does not reuse samples/assets for %s changes, even when a grade changes too',(_label,edit)=>{
    const previous=source(),next=structuredClone(previous);edit(next);next.postProcessing={enabled:true,exposureEV:.3};
    expect(viewportSceneKey(next)).not.toBe(viewportSceneKey(previous));
    expect(isImageFinishOnlyChange(previous,next)).toBe(false);
  });
  it('does not treat missing scenes as a reusable evaluated revision',()=>{
    expect(isImageFinishOnlyChange(null,source())).toBe(false);
    expect(isImageFinishOnlyChange(source(),undefined)).toBe(false);
    expect(isImageFinishOnlyChange(null,null)).toBe(false);
  });
});
