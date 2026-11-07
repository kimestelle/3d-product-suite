import { CURVE_PRESETS, type CurveFamily } from '../curvePresets';
import { frameBounds, framePath, type FrameNodes } from '../frameGeometry';

const SHAPES = [
  { id: 'circle', preset: 'studio-circle', symmetry: 'central' },
  { id: 'square', preset: 'windows-square', symmetry: 'central' },
  { id: 'frame', preset: 'studio-landing', symmetry: 'central' },
  { id: 'capsule', preset: 'poses-capsule', symmetry: 'central' },
  { id: 'triangle', preset: 'polygons-triangle', symmetry: 'mirror' },
  { id: 'diamond', preset: 'polygons-diamond', symmetry: 'central' },
  { id: 'pentagon', preset: 'polygons-pentagon', symmetry: 'mirror' },
  { id: 'hexagon', preset: 'polygons-hexagon', symmetry: 'central' },
  { id: 'trapezoid', preset: 'architectural-trapezoid', symmetry: 'mirror' },
  { id: 'octagon', preset: 'architectural-octagon', symmetry: 'central' },
  { id: 'arch', preset: 'corners-arch', symmetry: 'mirror' },
  { id: 'cross', preset: 'studio-cross', symmetry: 'central' },
  { id: 'plus', preset: 'symbols-plus', symmetry: 'central' },
  { id: 'star', preset: 'symbols-star', symmetry: 'central' },
  { id: 'oval', preset: 'primitives-oval', symmetry: 'central' },
] as const;

export type WorldShape = typeof SHAPES[number]['id'];
export type WorldSymmetry = typeof SHAPES[number]['symmetry'];
export const PRODUCT_RADIUS = 44;

/** A conservative distance to the actual cubic boundary, not its anchors or
 * bounding box. The derivative's control hull bounds its speed, so subtracting
 * half a sample step of that speed bounds the unseen interval as well. */
function minimumRadius(nodes: FrameNodes): number {
  const steps = 512;
  let lowerBound = Infinity;
  for (let index = 0; index < nodes.length; index++) {
    const a = nodes[index].point, b = nodes[index].out;
    const c = nodes[(index + 1) % nodes.length].in, d = nodes[(index + 1) % nodes.length].point;
    const speed = 3 * Math.max(Math.hypot(b.x - a.x, b.y - a.y),
      Math.hypot(c.x - b.x, c.y - b.y), Math.hypot(d.x - c.x, d.y - c.y));
    let sampled = Infinity;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps, u = 1 - t;
      const x = u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x;
      const y = u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y;
      sampled = Math.min(sampled, Math.hypot(x - 500, y - 300));
    }
    lowerBound = Math.min(lowerBound, sampled - speed / (2 * steps));
  }
  return lowerBound;
}

const definitions = SHAPES.map(shape => {
  const preset = CURVE_PRESETS.find(candidate => candidate.id === shape.preset);
  if (!preset) throw new Error(`The native curve catalog is missing ${shape.preset}.`);
  return { ...shape, name: preset.name, family: preset.family, nodes: preset.nodes,
    path: framePath(preset.nodes), bounds: frameBounds(preset.nodes), minimumRadius: minimumRadius(preset.nodes) };
});
export const WORLD_SHAPES: readonly { id: WorldShape; name: string; family: CurveFamily; symmetry: WorldSymmetry }[] =
  definitions.map(({ id, name, family, symmetry }) => ({ id, name, family, symmetry }));
const byId = new Map(definitions.map(shape => [shape.id, shape]));

export function getWorldGeometry(shape: WorldShape) {
  return byId.get(shape) ?? byId.get('circle')!;
}

export const NESTED_SIZES = [
  { id: 'large', name: 'Large', gap: 10 },
  { id: 'medium', name: 'Medium', gap: 14 },
  { id: 'small', name: 'Small', gap: 20 },
] as const;
export type NestedSize = typeof NESTED_SIZES[number]['id'];

/** The gap is a true circular hole. Smaller optical sizes get more clearance;
 * neither the product circle nor the native outer contour changes shape. */
export function getNestedMetrics(state: { shape: WorldShape; size: NestedSize }, compact = false) {
  const geometry = getWorldGeometry(state.shape);
  const preset = NESTED_SIZES.find(candidate => candidate.id === state.size) ?? NESTED_SIZES[0];
  const gap = preset.gap;
  const radius = PRODUCT_RADIUS + gap;
  const worldScale = compact ? .89 : .85;
  const worldMinimumRadius = geometry.minimumRadius * worldScale;
  return { size: preset.id, gap, radius, openingRadius: radius, maskRadius: radius / worldScale,
    worldScale, productRadius: PRODUCT_RADIUS, worldMinimumRadius,
    minimumMaterialClearance: worldMinimumRadius - radius };
}
