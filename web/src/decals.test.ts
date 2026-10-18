import { afterEach, describe, expect, it, vi } from 'vitest';
import { decalCoordinate, decalIntersectsUv, decalSurfaceHeight, hasUvOverlap, projectDecalTriangle, type ProductDecal, type SurfaceTriangle } from './decals';
import { StudioViewport } from './viewport';
import * as THREE from 'three';
const decal: ProductDecal = { id: 'ink', componentId: 'body', partId: 'body', text: 'gesso', subtitle: '', centerUv: [.5, .5], sizeUv: [.4, .4], rotationDeg: 0, heightM: .002, bevelM: .0005 };
const triangle: SurfaceTriangle = [
  { position: [0, 0, 0], normal: [0, 0, 1], uv: [0, 0] },
  { position: [.1, 0, 0], normal: [0, 0, 1], uv: [1, 0] },
  { position: [0, .1, 0], normal: [0, 0, 1], uv: [0, 1] },
];
afterEach(() => vi.unstubAllGlobals());
describe('UV decals on real surfaces', () => {
  it('warns only when artwork has no positive-area intersection with the mapped surface', () => {
    const island = [[0, 0, 1, 0, 0, 1]];
    expect(decalIntersectsUv(island, decal)).toBe(true);
    expect(decalIntersectsUv(island, { ...decal, centerUv: [.9, .9], sizeUv: [.1, .1] })).toBe(false);
    expect(decalIntersectsUv(island, { ...decal, centerUv: [1.2, .2], sizeUv: [.4, .4] })).toBe(false); // touches a vertex
    expect(decalIntersectsUv(island, { ...decal, centerUv: [.6, .6], rotationDeg: 45 })).toBe(true);
    expect(decalIntersectsUv([[0, 0, 0, 0, 0, 0]], decal)).toBe(false);
    expect(decalIntersectsUv([], decal)).toBe(false);
    expect(decalIntersectsUv(island, { ...decal, sizeUv: [0, .2] })).toBe(false);
    expect(decalIntersectsUv([[NaN, 0, 1, 0, 0, 1]], decal)).toBe(false);
  });
  it('clips a rotated patch to the source triangle at physically measured height', () => {
    const result = projectDecalTriangle(triangle, { ...decal, rotationDeg: 35 });
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.normals.length).toBe(result.positions.length);
    expect(result.uvs.length * 3).toBe(result.positions.length * 2);
    for (let i = 0; i < result.positions.length; i += 3) {
      expect(result.positions[i]).toBeGreaterThanOrEqual(-1e-10);
      expect(result.positions[i + 1]).toBeGreaterThanOrEqual(-1e-10);
      expect(result.positions[i] + result.positions[i + 1]).toBeLessThanOrEqual(.1 + 1e-10);
      expect(result.positions[i + 2]).toBeGreaterThanOrEqual(0);
      expect(result.positions[i + 2]).toBeLessThanOrEqual(.002 + 1e-10);
    }
    expect(Math.max(...result.positions.filter((_, i) => i % 3 === 2))).toBeCloseTo(.002, 9);
    result.uvs.forEach(v => { expect(v).toBeGreaterThanOrEqual(-1e-10); expect(v).toBeLessThanOrEqual(1 + 1e-10); });
  });
  it('keeps UV seams disconnected and rejects degenerate UV triangles', () => {
    const seamSide = triangle.map(v => ({ ...v, uv: [v.uv[0] * .1 + .9, v.uv[1]] })) as SurfaceTriangle;
    expect(projectDecalTriangle(seamSide, { ...decal, centerUv: [.1, .5], sizeUv: [.1, .1] }).positions).toEqual([]);
    expect(projectDecalTriangle(triangle.map(v => ({ ...v, uv: [0, 0] })) as SurfaceTriangle, decal).positions).toEqual([]);
    expect(projectDecalTriangle(triangle, { ...decal, sizeUv: [0, .4] }).positions).toEqual([]);
  });
  it('rounds the bevel in meters, caps its width, and retains declared height', () => {
    expect(decalSurfaceHeight(0, .002, .0005)).toBeCloseTo(.0015);
    expect(decalSurfaceHeight(.00025, .002, .0005)).toBeCloseTo(.0019330127);
    expect(decalSurfaceHeight(.0005, .002, .0005)).toBe(.002);
    expect(decalSurfaceHeight(0, .002, .9)).toBe(.001);
    expect(decalSurfaceHeight(0, 0, .1)).toBe(0);
  });
  it('rotates around the decal center and offsets along the source surface normal', () => {
    expect(decalCoordinate([.5, .7], { ...decal, rotationDeg: 90 })[0]).toBeCloseTo(1);
    expect(decalCoordinate([.5, .7], { ...decal, rotationDeg: 90 })[1]).toBeCloseTo(.5);
    const side = triangle.map(v => ({ ...v, position: [0, v.position[0], v.position[1]], normal: [1, 0, 0] })) as SurfaceTriangle;
    const result = projectDecalTriangle(side, { ...decal, bevelM: 0 });
    const heights = result.positions.filter((_, i) => i % 3 === 0);
    expect(Math.max(...heights)).toBeCloseTo(.002); expect(Math.min(...heights)).toBe(0);
  });
  it('reports stacked islands but excludes shared triangle edges from overlap', () => {
    const lower = [0, 0, 1, 0, 0, 1], upper = [1, 0, 1, 1, 0, 1];
    expect(hasUvOverlap([lower, upper])).toBe(false);
    expect(hasUvOverlap([lower, [...lower]])).toBe(true);
    expect(hasUvOverlap([lower, [.3, .3, .6, .3, .3, .6]])).toBe(true);
  });
  it('gives procedural box faces separate real UV islands with a front placement suggestion', () => {
    const viewport = Object.create(StudioViewport.prototype) as any;
    const geometry = viewport.geometry('box', [.06, .08, .002], 0);
    const root = new THREE.Group(); root.userData.gessoPrimitiveShape = 'box';
    root.add(new THREE.Mesh(geometry)); viewport.parts = new Map([['label', root]]);
    const layout = viewport.getUvLayout('label');
    expect(layout.triangleCount).toBe(12); expect(layout.overlap).toBe(false); expect(layout.missingUv).toBe(false);
    expect(layout.suggestedCenterUv).toEqual([.5, .75]);
    const uv = geometry.getAttribute('uv'), front = geometry.groups[4];
    for (let i = front.start; i < front.start + front.count; i++) {
      const index = geometry.index.getX(i);
      expect(uv.getX(index)).toBeGreaterThanOrEqual(1 / 3 - 1e-7);
      expect(uv.getX(index)).toBeLessThanOrEqual(2 / 3 + 1e-7);
      expect(uv.getY(index)).toBeGreaterThanOrEqual(.5 - 1e-7);
    }
  });

  it('attaches ink to the selected imported mesh and measures height after its scale', () => {
    const viewport = Object.create(StudioViewport.prototype) as any;
    const context = { fillStyle: '', textAlign: '', textBaseline: '', font: '', fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ width: 90 }) };
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
    const root = new THREE.Group(), mesh = new THREE.Mesh(new THREE.PlaneGeometry(.1, .1));
    mesh.scale.set(2, 3, 4); mesh.position.set(.2, .3, .4); root.add(mesh);
    const content = new THREE.Group(); content.add(root);
    Object.assign(viewport, { content, components: new Map([['body', root]]), parts: new Map([['body::node:2', mesh]]),
      renderer: { capabilities: { getMaxAnisotropy: () => 8 } } });
    viewport.addDecals([{ ...decal, partId: 'body::node:2', bevelM: 0 }]);
    const ink = mesh.children[0] as THREE.Mesh;
    expect(ink.userData.gessoArtwork).toBe(true); expect(ink.parent).toBe(mesh);
    const position = ink.geometry.getAttribute('position');
    expect(Math.max(...Array.from({ length: position.count }, (_, i) => position.getZ(i)))).toBeCloseTo(.002 / 4, 8);
    root.position.y = 1; root.updateMatrixWorld(true);
    expect(ink.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(1.3);
    expect(viewport.getUvLayout('body::node:2').triangleCount).toBe(2);
  });
  it('excludes artwork meshes and reports missing or partially missing UVs honestly', () => {
    const viewport = Object.create(StudioViewport.prototype) as any;
    const root = new THREE.Group(), source = new THREE.Mesh(new THREE.PlaneGeometry(.1, .1)); root.add(source);
    const art = new THREE.Mesh(new THREE.PlaneGeometry(.1, .1)); art.userData.gessoArtwork = true; source.add(art);
    root.add(new THREE.Mesh(new THREE.BufferGeometry())); viewport.parts = new Map([['part', root]]);
    const layout = viewport.getUvLayout('part');
    expect(layout.triangleCount).toBe(2); expect(layout.overlap).toBe(false); expect(layout.partialUv).toBe(true);
    expect(viewport.getUvLayout('absent').missingUv).toBe(true);
  });
});
