import {describe, expect, it} from 'vitest';
import {APERTURE_NODE_COUNT, landingMorphNodes, landingMorphPath, type ApertureNode} from './landingMorph';
import {aperturePath, cloneApertureNodes, moveApertureAnchor, moveApertureHandle, parseApertureNodes} from './apertureGeometry';

const length = (node: ApertureNode, handle: 'in' | 'out') => Math.hypot(node[handle].x - node.point.x, node[handle].y - node.point.y);
const cross = (node: ApertureNode) => (node.in.x - node.point.x) * (node.out.y - node.point.y) - (node.in.y - node.point.y) * (node.out.x - node.point.x);
function withNode(node: ApertureNode) { const nodes = landingMorphNodes(.5); nodes[0] = node; return nodes; }
const asymmetric = () => withNode({point: {x: 500, y: 300}, in: {x: 480, y: 300}, out: {x: 540, y: 300}});

describe('Editable aperture geometry', () => {
  it('reproduces the existing landing path byte for byte throughout the morph', () => {
    for (let index = 0; index <= 100; index++) {
      const progress = index / 100, nodes = landingMorphNodes(progress);
      expect(nodes).toHaveLength(APERTURE_NODE_COUNT);
      expect(aperturePath(nodes)).toBe(landingMorphPath(progress));
    }
    for (const progress of [NaN, Infinity, -Infinity, -2, 3]) expect(aperturePath(landingMorphNodes(progress))).toBe(landingMorphPath(progress));
  });
  it('moves an anchor with both handles without changing their vectors or the input', () => {
    const nodes = asymmetric(), before = structuredClone(nodes);
    const moved = moveApertureAnchor(nodes, 0, {x: 525, y: 275});
    expect(moved[0]).toEqual({point: {x: 525, y: 275}, in: {x: 505, y: 275}, out: {x: 565, y: 275}});
    expect(nodes).toEqual(before);
    expect(moved[1]).toEqual(nodes[1]);
    expect(moved[1]).not.toBe(nodes[1]);
  });
  it('clamps the complete anchor group rather than shortening handles', () => {
    const moved = moveApertureAnchor(asymmetric(), 0, {x: 2000, y: -20});
    expect(moved[0]).toEqual({point: {x: 960, y: 0}, in: {x: 940, y: 0}, out: {x: 1000, y: 0}});
    expect(() => cloneApertureNodes(moved)).not.toThrow();
  });
  it('moves a free handle independently', () => {
    const nodes = asymmetric(), moved = moveApertureHandle(nodes, 0, 'out', {x: 530, y: 340});
    expect(moved[0].out).toEqual({x: 530, y: 340});
    expect(moved[0].in).toEqual(nodes[0].in);
    expect(moved[0].point).toEqual(nodes[0].point);
    expect(nodes[0].out).toEqual({x: 540, y: 300});
  });
  it('aligns opposite handles while retaining the opposite length', () => {
    const moved = moveApertureHandle(asymmetric(), 0, 'out', {x: 530, y: 340}, 'aligned');
    expect(moved[0].in).toEqual({x: 488, y: 284});
    expect(length(moved[0], 'in')).toBe(20);
    expect(length(moved[0], 'out')).toBe(50);
    expect(cross(moved[0])).toBeCloseTo(0, 10);
  });
  it('mirrors symmetric handles and constrains both equally at an edge', () => {
    const nodes = withNode({point: {x: 980, y: 300}, in: {x: 960, y: 300}, out: {x: 990, y: 300}});
    const moved = moveApertureHandle(nodes, 0, 'in', {x: 880, y: 300}, 'symmetric');
    expect(moved[0]).toEqual({point: {x: 980, y: 300}, in: {x: 960, y: 300}, out: {x: 1000, y: 300}});
    expect(length(moved[0], 'in')).toBe(length(moved[0], 'out'));
    expect(cross(moved[0])).toBeCloseTo(0, 10);
  });
  it('shortens an aligned opposite handle only at the boundary', () => {
    const nodes = withNode({point: {x: 990, y: 300}, in: {x: 970, y: 300}, out: {x: 990, y: 350}});
    const moved = moveApertureHandle(nodes, 0, 'in', {x: 970, y: 300}, 'aligned');
    expect(moved[0].out).toEqual({x: 1000, y: 300});
    expect(cross(moved[0])).toBeCloseTo(0, 10);
  });
  it('handles collapsed tangents without dividing by zero', () => {
    const nodes = asymmetric(), symmetric = moveApertureHandle(nodes, 0, 'out', nodes[0].point, 'symmetric');
    expect(symmetric[0].in).toEqual(symmetric[0].point);
    expect(symmetric[0].out).toEqual(symmetric[0].point);
    const aligned = moveApertureHandle(nodes, 0, 'out', nodes[0].point, 'aligned');
    expect(aligned[0].in).toEqual(nodes[0].in);
    expect(() => aperturePath(symmetric)).not.toThrow();
  });
  it('retains prior coordinates when a drag reports a non-finite value', () => {
    const nodes = asymmetric();
    expect(moveApertureAnchor(nodes, 0, {x: NaN, y: Infinity})).toEqual(nodes);
    expect(moveApertureHandle(nodes, 0, 'out', {x: -Infinity, y: NaN})).toEqual(nodes);
  });
  it('closes the final cubic on the first anchor after arbitrary edits', () => {
    let nodes = moveApertureAnchor(landingMorphNodes(0), 0, {x: 650, y: 330});
    nodes = moveApertureHandle(nodes, 63, 'out', {x: 730, y: 250});
    const path = aperturePath(nodes);
    expect(path.match(/ C /g)).toHaveLength(64);
    const numbers = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(numbers.slice(-2)).toEqual(numbers.slice(0, 2));
    expect(path.endsWith(' Z')).toBe(true);
  });
  it('round-trips JSON into fresh geometry and drops unrelated fields', () => {
    const original = landingMorphNodes(.25), data = original.map(node => ({...node, label: '<script>'}));
    const cloned = cloneApertureNodes(data), parsed = parseApertureNodes(JSON.stringify(data));
    expect(parsed).toEqual(original);
    expect(cloned).toEqual(original);
    expect(cloned[0].in).not.toBe(original[0].in);
    cloned[0].point.x++;
    expect(original[0].point.x).not.toBe(cloned[0].point.x);
  });
  it('rejects invalid JSON, topology, missing coordinates, and unsafe numeric values', () => {
    expect(() => parseApertureNodes('{')).toThrow('valid JSON');
    for (const value of [null, {}, [], landingMorphNodes(0).slice(1), new Array(64)]) expect(() => cloneApertureNodes(value)).toThrow();
    for (const value of [NaN, Infinity, -1, 1001, '500', null]) {
      const nodes: any = landingMorphNodes(.5); nodes[0].point.x = value;
      expect(() => cloneApertureNodes(nodes)).toThrow();
    }
    const missing: any = landingMorphNodes(.5); delete missing[1].in;
    expect(() => cloneApertureNodes(missing)).toThrow();
    expect(() => moveApertureAnchor(landingMorphNodes(0), 64, {x: 500, y: 300})).toThrow('existing');
    expect(() => moveApertureAnchor(landingMorphNodes(0), .5, {x: 500, y: 300})).toThrow('existing');
  });
});
