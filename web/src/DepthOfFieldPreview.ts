import * as THREE from 'three';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {resolvePostProcessing,type PostProcessingSettings} from './postProcessing';
import {circleOfConfusionMm, type DepthOfFieldSample} from './focusOptics';
import {previewPostSamples} from './previewAntialias';

/** Screen-space thin-lens preview. Gaussian splats use their own native optical blur. */
export class DepthOfFieldPreview {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private sampleCount=-1;
  private antialiasState:boolean|null=null;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, {type: THREE.HalfFloatType, minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter, depthBuffer: true, stencilBuffer: false});
    this.target.texture.name = 'gesso / depth-of-field linear color';
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.target.depthTexture.name = 'gesso / depth-of-field mesh depth';
    this.target.depthTexture.minFilter = this.target.depthTexture.magFilter = THREE.NearestFilter;
    this.material = new THREE.ShaderMaterial({
      name: 'gesso / thin-lens preview', depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {tColor: {value: this.target.texture}, tDepth: {value: this.target.depthTexture},
        resolution: {value: new THREE.Vector2(1, 1)}, nearClip: {value: .001}, farClip: {value: 100},
        focusDistance: {value: 1}, cocScale: {value: 0}, splatBackground: {value: false}, maxRadius: {value: 32},
        gradeA:{value:new THREE.Vector4(0,1,1,0)}, gradeB:{value:new THREE.Vector4()}, gradeC:{value:new THREE.Vector4()},
        finishGate:{value:new THREE.Vector4(0,0,1,1)}},
      vertexShader: `varying vec2 vUv;
        void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`,
      fragmentShader: `
        varying vec2 vUv;
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform vec2 resolution;
        uniform float nearClip;
        uniform float farClip;
        uniform float focusDistance;
        uniform float cocScale;
        uniform float maxRadius;
        uniform vec4 gradeA;
        uniform vec4 gradeB;
        uniform vec4 gradeC;
        uniform vec4 finishGate;
        vec3 gradeColor(vec3 c){
          c*=exp2(gradeA.x)*vec3(1.0+.12*gradeB.x,1.0+.06*gradeB.y,1.0-.12*gradeB.x);
          float y=dot(clamp(c,0.0,1.0),vec3(.2126,.7152,.0722));
          c+=gradeB.w*.18*pow(1.0-y,2.0)+gradeB.z*.18*y*y;
          c=(c-.5)*gradeA.y+.5;
          float gray=dot(c,vec3(.2126,.7152,.0722));
          return clamp(mix(vec3(gray),c,gradeA.z),0.0,1.0);
        }
        vec3 displaySample(vec2 uv){
          vec3 c=texture2D(tColor,uv).rgb;
          #if defined(TONE_MAPPING)
          if(texture2D(tDepth,uv).r<.999999)c=toneMapping(c);
          #endif
          return gradeColor(linearToOutputTexel(vec4(c,1.0)).rgb);
        }
        uniform bool splatBackground;
        #include <packing>
        float viewDepth(vec2 uv){return -perspectiveDepthToViewZ(texture2D(tDepth,uv).r,nearClip,farClip);}
        void main(){
          float rawDepth=texture2D(tDepth,vUv).r;
          float z=viewDepth(vUv);
          float radius=min(maxRadius,abs((z-focusDistance)/max(z,nearClip))*cocScale);
          // Splats already use actual per-splat depth in Spark's native aperture shader.
          // They intentionally do not write a hard surface to the mesh depth texture.
          if(splatBackground && rawDepth>=0.999999) radius=0.0;
          vec4 color=texture2D(tColor,vUv);
          float weight=1.0;
          if(radius>0.35){
            for(int i=0;i<40;i++){
              float t=(float(i)+0.5)/40.0;
              float angle=float(i)*2.39996323;
              vec2 offset=vec2(cos(angle),sin(angle))*sqrt(t)*radius/resolution;
              vec2 uv=clamp(vUv+offset,0.5/resolution,vec2(1.0)-0.5/resolution);
              float sampleDepth=viewDepth(uv);
              float sampleRadius=min(maxRadius,abs((sampleDepth-focusDistance)/max(sampleDepth,nearClip))*cocScale);
              // Keep a sharp foreground from bleeding over an out-of-focus background.
              float contribution=sampleDepth<z && sampleRadius<length(offset*resolution)
                ? smoothstep(0.0,1.0,sampleRadius/max(length(offset*resolution),0.001)) : 1.0;
              color+=texture2D(tColor,uv)*contribution;
              weight+=contribution;
            }
          }
          gl_FragColor=color/weight;
          // Flat clear color and native splat pixels bypassed tone mapping in the
          // direct path as well; keep their appearance when enabling mesh DOF.
          if(rawDepth<0.999999){
            #include <tonemapping_fragment>
          }
          #include <colorspace_fragment>
          if(gradeA.w>.5){
            vec3 finished=gradeColor(gl_FragColor.rgb);
            vec2 outputSize=resolution*finishGate.zw;
            vec2 outputUv=(vUv-finishGate.xy)/finishGate.zw;
            if(gradeC.z>0.0){
              vec3 glow=max(finished-.7,0.0);
              vec2 radius=.008*max(outputSize.x,outputSize.y)/resolution;
              for(int j=0;j<12;j++){
                float angle=float(j)*6.2831853/12.0;
                vec2 uv=clamp(vUv+vec2(cos(angle),sin(angle))*radius,
                  finishGate.xy+.5/resolution,finishGate.xy+finishGate.zw-.5/resolution);
                glow+=max(displaySample(uv)-.7,0.0);
              }
              finished+=glow/13.0*gradeC.z*.35;
            }
            float r=length((outputUv-.5)*vec2(gradeC.w,1.0));
            finished*=1.0-gradeC.x*.65*smoothstep(.2,.85,r);
            if(gradeC.y>0.0){
              vec2 pixel=mod(floor(vec2(outputUv.x,1.0-outputUv.y)*outputSize),128.0);
              float noise=mod(pixel.x*73.0+pixel.y*151.0+mod(pixel.x*pixel.y*19.0,251.0),256.0)/255.0;
              finished+=gradeC.y*(noise-.5);
            }
            gl_FragColor.rgb=clamp(finished,0.0,1.0);
          }
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    width: number, height: number, optics: DepthOfFieldSample | null, focalLengthMm: number, splatBackground: boolean,
    finish?: Partial<PostProcessingSettings>, gate?:{x:number;y:number;width:number;height:number},antialias=true): void {
    if(this.antialiasState!==antialias){
      const next=antialias?previewPostSamples(renderer):0;
      if(this.sampleCount>=0&&next!==this.sampleCount)this.target.dispose();
      this.target.samples=next;this.sampleCount=next;
      this.antialiasState=antialias;
    }
    const ratio = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * ratio)), h = Math.max(1, Math.floor(height * ratio));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const u = this.material.uniforms;
    u.resolution.value.set(w, h); u.nearClip.value = camera.near; u.farClip.value = camera.far;
    u.focusDistance.value = optics?.focusDistanceM??1;
    // At twice the focus distance, abs((z-S)/z)=1/2, so this gives the coefficient.
    u.cocScale.value = optics?.enabled?Math.abs(circleOfConfusionMm(optics.focusDistanceM * 2, focalLengthMm, optics.focusDistanceM, optics.fStop)) / 36 * h * camera.zoom:0;
    u.splatBackground.value = splatBackground;
    const grade=resolvePostProcessing(finish);
    u.gradeA.value.set(grade.exposureEV,grade.contrast,grade.saturation,grade.enabled?1:0);
    u.gradeB.value.set(grade.temperature,grade.tint,grade.highlights,grade.shadows);
    u.gradeC.value.set(grade.vignette,grade.grain,grade.bloom,gate?gate.width/gate.height:w/h);
    u.finishGate.value.set(gate?gate.x/width:0,gate?1-(gate.y+gate.height)/height:0,gate?gate.width/width:1,gate?gate.height/height:1);
    const previous = renderer.getRenderTarget();
    try {
      // Render targets are linear in Three; the final shader performs tone mapping and sRGB once.
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previous);
      this.quad.render(renderer);
    } finally {renderer.setRenderTarget(previous);}
  }

  dispose(): void {this.target.dispose(); this.material.dispose(); this.quad.dispose();}
}
