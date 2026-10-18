import * as THREE from 'three';
import {FullScreenQuad} from 'three/addons/postprocessing/Pass.js';
import {circleOfConfusionMm, type DepthOfFieldSample} from './focusOptics';

/** Screen-space thin-lens preview. Gaussian splats use their own native optical blur. */
export class DepthOfFieldPreview {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

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
        focusDistance: {value: 1}, cocScale: {value: 0}, splatBackground: {value: false}, maxRadius: {value: 32}},
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
        }`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera,
    width: number, height: number, optics: DepthOfFieldSample, focalLengthMm: number, splatBackground: boolean): void {
    const ratio = renderer.getPixelRatio();
    const w = Math.max(1, Math.floor(width * ratio)), h = Math.max(1, Math.floor(height * ratio));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const u = this.material.uniforms;
    u.resolution.value.set(w, h); u.nearClip.value = camera.near; u.farClip.value = camera.far;
    u.focusDistance.value = optics.focusDistanceM;
    // At twice the focus distance, abs((z-S)/z)=1/2, so this gives the coefficient.
    u.cocScale.value = Math.abs(circleOfConfusionMm(optics.focusDistanceM * 2, focalLengthMm, optics.focusDistanceM, optics.fStop)) / 36 * h * camera.zoom;
    u.splatBackground.value = splatBackground;
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
