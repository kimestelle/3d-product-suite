import * as THREE from 'three';
import {sceneAssetUrl} from './sceneObjects';
import type {FilmGateRect} from './filmGuides';

export type FilmClip = {kind: 'scene' | 'black'} | {kind: 'image'; asset: {path: string; sha256: string; width: number; height: number}; fit: 'contain' | 'cover'};

/** Same centered fit used by exported images; contain leaves black letterboxing. */
export function imagePlaneSize(width: number, height: number, aspect: number, fit: 'contain' | 'cover') {
  const ratio = width / height / aspect;
  return fit === 'cover' ? {x: Math.max(1, ratio), y: Math.max(1, 1 / ratio)} : {x: Math.min(1, ratio), y: Math.min(1, 1 / ratio)};
}

/** Unlit image playback shares the viewport's canvas, sizing and presentation clock. */
export class FilmImageRenderer {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  private readonly material = new THREE.MeshBasicMaterial({toneMapped: false, transparent: true, depthTest: false});
  private readonly plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
  private readonly textures = new Map<string, THREE.Texture>();
  private disposed = false;
  constructor() {this.camera.position.z = 1; this.scene.background = new THREE.Color(0); this.scene.add(this.plane);}

  async prepare(shots: any[], signal: AbortSignal) {
    const assets = new Map<string, any>(shots.filter(shot => shot.kind === 'image').map(shot => [shot.image.asset.sha256, shot.image.asset]));
    for (const [key, texture] of this.textures) if (!assets.has(key)) {this.release(texture); this.textures.delete(key);}
    for (const [key, asset] of assets) {
      if (this.textures.has(key)) continue;
      const response = await fetch(sceneAssetUrl(asset), {signal});
      if (!response.ok) throw new Error('The image clip could not be loaded.');
      const bytes = await response.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
      if (digest !== key) throw new Error('The image clip has changed since it was imported.');
      const bitmap = await createImageBitmap(new Blob([bytes]), {imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none'});
      if (this.disposed || signal.aborted) {bitmap.close(); return;}
      const texture = new THREE.Texture(bitmap); texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
      this.textures.set(key, texture);
    }
  }

  draw(renderer: THREE.WebGLRenderer, clip: FilmClip, size: {width: number; height: number}, gate: FilmGateRect) {
    const image = clip.kind === 'image' ? clip : null;
    this.plane.visible = !!image;
    if (image) {
      const texture = this.textures.get(image.asset.sha256);
      if (!texture) throw new Error('The image clip is not ready.');
      if (this.material.map !== texture) {this.material.map = texture; this.material.needsUpdate = true;}
      const scale = imagePlaneSize(image.asset.width, image.asset.height, gate.width / gate.height, image.fit);
      this.plane.scale.set(scale.x, scale.y, 1);
    }
    // Fill the surrounding viewport black, then render inside the actual output gate.
    const clear = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
    renderer.setClearColor(0, 1); renderer.clear();
    renderer.setViewport(gate.x, size.height - gate.y - gate.height, gate.width, gate.height);
    renderer.setScissor(gate.x, size.height - gate.y - gate.height, gate.width, gate.height); renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false); renderer.setViewport(0, 0, size.width, size.height); renderer.setClearColor(clear, alpha);
  }
  private release(texture: THREE.Texture) {texture.dispose(); (texture.image as ImageBitmap)?.close?.();}
  dispose() {this.disposed = true; for (const texture of this.textures.values()) this.release(texture); this.textures.clear(); this.plane.geometry.dispose(); this.material.dispose();}
}
