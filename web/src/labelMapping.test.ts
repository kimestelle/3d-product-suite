import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { labelFaceCoverage, labelGeometry, labelImageDimensions, labelTemplateSvg, projectLabelPoint, transformLabelUv, unwrapLabelSeam, type LabelMapping } from './labelMapping';

const mapping: LabelMapping = { mode: 'planar', face: 'front', scale: [1, 1], offset: [0, 0], rotationDegrees: 0 };

function triangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 1, 1, -1, 1, -1, 1, 1], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
  return geometry;
}

describe('label mapping in component-local canonical coordinates', () => {
  it.each([
    ['front', [1, 1, 1]], ['back', [-1, 1, -1]], ['right', [1, 1, -1]],
    ['left', [-1, 1, 1]], ['top', [1, 1, -1]], ['bottom', [1, -1, 1]],
  ] as const)('orients %s artwork right and up from that face', (face, point) => {
    expect(projectLabelPoint(new THREE.Vector3(...point), [2, 2, 2], { ...mapping, face })).toEqual([1, 1]);
  });

  it('limits artwork to selected faces and cylindrical sides', () => {
    expect(labelFaceCoverage(new THREE.Vector3(0, 0, 1), mapping)).toBe(1);
    expect(labelFaceCoverage(new THREE.Vector3(0, 0, -1), mapping)).toBe(0);
    expect(labelFaceCoverage(new THREE.Vector3(1, 0, 0), mapping)).toBe(0);
    expect(labelFaceCoverage(new THREE.Vector3(0, 1, 0), { ...mapping, mode: 'cylindrical' })).toBe(0);
    expect(labelFaceCoverage(new THREE.Vector3(0, 0, 1), { ...mapping, mode: 'cylindrical' })).toBe(1);
  });

  it('applies artwork position, scale, then inverse rotation without texture repeat', () => {
    expect(transformLabelUv([.75, .5], { ...mapping, scale: [.5, 1] })).toEqual([1, .5]);
    expect(transformLabelUv([.75, .5], { ...mapping, offset: [.25, 0] })).toEqual([.5, .5]);
    const uv = transformLabelUv([1, .5], { ...mapping, rotationDegrees: 90 });
    expect(uv[0]).toBeCloseTo(.5); expect(uv[1]).toBeCloseTo(0);
    expect(transformLabelUv([0, 0], { ...mapping, scale: [.5, .5] })).toEqual([-.5, -.5]);
  });

  it('unwraps triangles crossing the cylinder seam rather than stretching across the front', () => {
    const uvs: [number, number][] = [[.99, 0], [.01, 0], [.02, 1]];
    unwrapLabelSeam(uvs);
    expect(uvs).toEqual([[.99, 0], [1.01, 0], [1.02, 1]]);
    expect(projectLabelPoint(new THREE.Vector3(0, 0, 1), [2, 2, 2], { ...mapping, mode: 'cylindrical' })).toEqual([.5, .5]);
    const wrap = { ...mapping, mode: 'cylindrical' as const };
    expect(transformLabelUv([1.01, .5], wrap)[0]).toBeCloseTo(.01);
    // A label shifted onto the rear spans both sides of the UV seam.
    expect(transformLabelUv([.99, .5], { ...wrap, scale: [.4, 1], offset: [.5, 0] })[0]).toBeCloseTo(.475);
    expect(transformLabelUv([1.01, .5], { ...wrap, scale: [.4, 1], offset: [.5, 0] })[0]).toBeCloseTo(.525);
  });

  it('uses real nested node transforms, preserving source geometry and material groups', () => {
    const original = triangle(); original.setIndex([0, 1, 2]); original.addGroup(0, 3, 2);
    const projected = labelGeometry(original, new THREE.Matrix4().makeTranslation(1, 0, 0), [4, 2, 2], mapping);
    expect(projected.index).toBeNull(); expect(projected.groups).toEqual(original.groups);
    expect(Array.from(projected.getAttribute('labelUv').array)).toEqual([.5, 0, 1, 0, .5, 1]);
    expect(Array.from(original.getAttribute('uv').array)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(original.getAttribute('labelUv')).toBeUndefined();
  });

  it('normalizes glTF source UV v-down to artwork v-up and fails clearly without UVs', () => {
    const original = triangle();
    const projected = labelGeometry(original, new THREE.Matrix4(), [2, 2, 2], { ...mapping, mode: 'uv' });
    expect(Array.from(projected.getAttribute('labelUv').array)).toEqual([0, 1, 1, 1, 0, 0]);
    original.deleteAttribute('uv');
    expect(() => labelGeometry(original, new THREE.Matrix4(), [2, 2, 2], { ...mapping, mode: 'uv' })).toThrow('no UV map');
  });

  it('keeps the normal direction under mirrored imported nodes as Three and Blender do', () => {
    const mirrored = labelGeometry(triangle(), new THREE.Matrix4().makeScale(-1, 1, 1), [2, 2, 2], mapping);
    expect(Array.from(mirrored.getAttribute('labelCoverage').array)).toEqual([1, 1, 1]);
    expect(Array.from(mirrored.getAttribute('labelUv').array)).toEqual([1, 0, 0, 0, 1, 1]);
  });

  it('exports actual UV wireframe with correct asymmetric image orientation, escaped names and bounded detail', () => {
    const projected = labelGeometry(triangle(), new THREE.Matrix4(), [2, 2, 2], { ...mapping, mode: 'uv' });
    const svg = labelTemplateSvg([projected], '<Product>');
    expect(svg).toContain('M0.000,0.000L1024.000,0.000');
    expect(svg).toContain('L0.000,1024.000');
    expect(svg).toContain('&lt;Product&gt;');
    expect(svg).toContain('id="artwork"');
    expect(labelTemplateSvg([projected], 'Product', 1)).toContain('detail limited');
    projected.getAttribute('labelCoverage').array.fill(0);
    expect(() => labelTemplateSvg([projected], 'Product')).toThrow('No surface faces');
  });
});

describe('label image dimension checks before decoding', () => {
  function png(width = 320, height = 640) {
    const data = new Uint8Array(33); data.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(data.buffer);
    view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, width); view.setUint32(20, height);
    return data.buffer;
  }
  it('reads verified PNG/JPEG dimensions and rejects bombs/truncated headers', () => {
    expect(labelImageDimensions(png(), 'png')).toEqual([320, 640]);
    expect(labelImageDimensions(new Uint8Array([255, 216, 255, 192, 0, 8, 8, 0, 10, 0, 20, 1]).buffer, 'jpg')).toEqual([20, 10]);
    expect(() => labelImageDimensions(png(8193, 1), 'png')).toThrow('8192');
    expect(() => labelImageDimensions(png(8192, 8192), 'png')).toThrow('32 megapixels');
    expect(() => labelImageDimensions(new Uint8Array(20).buffer, 'png')).toThrow('PNG');
    expect(() => labelImageDimensions(new Uint8Array([255, 216, 255, 192, 0, 255]).buffer, 'jpg')).toThrow('truncated');
  });
});
