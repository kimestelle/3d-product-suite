import type {ArtworkAsset} from './artwork';
/** UV coordinates are the source mesh coordinates, including seams and stacked islands. */
export type ProductDecal = {
  id: string; componentId: string; partId: string; text: string; subtitle: string; artwork?: ArtworkAsset;
  centerUv: [number, number]; sizeUv: [number, number]; rotationDeg: number; heightM: number; bevelM: number;
};
export type UvLayout = {
  partId: string; triangles: number[][]; triangleCount: number; missingUv: boolean;
  overlap: boolean; truncated: boolean; partialUv?: boolean;
  suggestedCenterUv?: [number, number]; suggestedSizeUv?: [number, number];
};
export type SurfaceVertex = { position: [number, number, number]; normal: [number, number, number]; uv: [number, number] };
export type SurfaceTriangle = [SurfaceVertex, SurfaceVertex, SurfaceVertex];
type Point = { q: [number, number]; position: [number, number, number]; normal: [number, number, number] };
export type DecalMeshData = { positions: number[]; normals: number[]; uvs: number[] };
const EPS = 1e-10;

export function decalCoordinate(uv: [number, number], decal: ProductDecal): [number, number] {
  const angle = decal.rotationDeg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const u = uv[0] - decal.centerUv[0], v = uv[1] - decal.centerUv[1];
  return [(u * c + v * s) / decal.sizeUv[0] + .5, (-u * s + v * c) / decal.sizeUv[1] + .5];
}
/** Exact source-triangle hit weights; no wrapping or interpolation across UV seams. */
export function uvBarycentricWeights(triangle: number[], uv: [number, number]): [number, number, number] | null {
  if (triangle.length !== 6 || [...triangle, ...uv].some(value => !Number.isFinite(value))) return null;
  const [au, av, bu, bv, cu, cv] = triangle;
  const determinant = (bu - au) * (cv - av) - (bv - av) * (cu - au);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const b = ((uv[0] - au) * (cv - av) - (uv[1] - av) * (cu - au)) / determinant;
  const c = ((bu - au) * (uv[1] - av) - (bv - av) * (uv[0] - au)) / determinant;
  const a = 1 - b - c;
  if (Math.min(a, b, c) < -1e-8 || Math.max(a, b, c) > 1 + 1e-8) return null;
  const weights = [Math.max(0, a), Math.max(0, b), Math.max(0, c)];
  const sum = weights.reduce((total, value) => total + value, 0);
  return weights.map(value => value / sum) as [number, number, number];
}

function mix(a: Point, b: Point, t: number): Point {
  return { q: a.q.map((x, i) => x + (b.q[i] - x) * t) as Point['q'],
    position: a.position.map((x, i) => x + (b.position[i] - x) * t) as Point['position'],
    normal: a.normal.map((x, i) => x + (b.normal[i] - x) * t) as Point['normal'] };
}
function clip(points: Point[], axis: 0 | 1, edge: number, sign: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const da = (a.q[axis] - edge) * sign, db = (b.q[axis] - edge) * sign;
    if (da >= -EPS) out.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) out.push(mix(a, b, da / (da - db)));
  }
  return out;
}
function rectangle(points: Point[], x0: number, x1: number, y0: number, y1: number): Point[] {
  return clip(clip(clip(clip(points, 0, x0, 1), 0, x1, -1), 1, y0, 1), 1, y1, -1);
}
/** True only where the rotated decal has positive area on a source UV island.
 * Uses the same clipping as projected geometry; callers must account for truncated layouts. */
export function decalIntersectsUv(triangles: number[][], decal: ProductDecal): boolean {
  if (decal.sizeUv.some(value => !Number.isFinite(value) || value <= EPS)
      || [...decal.centerUv, decal.rotationDeg].some(value => !Number.isFinite(value))) return false;
  for (const triangle of triangles) {
    if (triangle.length !== 6 || triangle.some(value => !Number.isFinite(value))) continue;
    const points = [0, 2, 4].map(i => ({ q: decalCoordinate([triangle[i], triangle[i + 1]], decal),
      position: [0, 0, 0], normal: [0, 0, 1] })) as Point[];
    const [a, b, c] = points;
    if (Math.abs((b.q[0] - a.q[0]) * (c.q[1] - a.q[1]) - (b.q[1] - a.q[1]) * (c.q[0] - a.q[0])) <= EPS) continue;
    const polygon = rectangle(points, 0, 1, 0, 1);
    const twiceArea = polygon.reduce((sum, point, i) => {
      const next = polygon[(i + 1) % polygon.length];
      return sum + point.q[0] * next.q[1] - point.q[1] * next.q[0];
    }, 0);
    if (Math.abs(twiceArea) > EPS) return true;
  }
  return false;
}

function normalized(v: number[]): [number, number, number] {
  const length = Math.hypot(...v);
  return length > EPS ? v.map(n => n / length) as [number, number, number] : [0, 0, 1];
}
function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function difference(a: number[], b: number[]): number[] { return a.map((x, i) => x - b[i]); }

/** A quarter-circle edge in physical meters; the remaining thickness is a vertical wall. */
export function decalSurfaceHeight(distanceM: number, heightM: number, bevelM: number): number {
  const h = Math.max(0, heightM), b = Math.min(Math.max(0, bevelM), h / 2);
  if (b <= EPS || distanceM >= b) return h;
  const d = Math.max(0, distanceM);
  return h - b + Math.sqrt(Math.max(0, b * b - (b - d) ** 2));
}

/** Clip to real UV triangles, never connect vertices across a UV seam or disconnected island.
 * Positions/normals must be in a meter coordinate space; output uses that same space. */
export function projectDecalTriangle(triangle: SurfaceTriangle, decal: ProductDecal): DecalMeshData {
  const out: DecalMeshData = { positions: [], normals: [], uvs: [] };
  if (decal.sizeUv.some(n => !Number.isFinite(n) || n <= EPS)
      || triangle.some(vertex => [...vertex.position, ...vertex.normal, ...vertex.uv].some(n => !Number.isFinite(n)))) return out;
  const points: Point[] = triangle.map(v => ({ q: decalCoordinate(v.uv, decal), position: v.position, normal: v.normal }));
  const [a, b, c] = points;
  const du1 = b.q[0] - a.q[0], dv1 = b.q[1] - a.q[1], du2 = c.q[0] - a.q[0], dv2 = c.q[1] - a.q[1];
  const determinant = du1 * dv2 - du2 * dv1;
  if (Math.abs(determinant) <= EPS) return out;
  const dp1 = difference(b.position, a.position), dp2 = difference(c.position, a.position);
  const derivativeU = dp1.map((v, i) => (v * dv2 - dp2[i] * dv1) / determinant);
  const derivativeV = dp1.map((v, i) => (dp2[i] * du1 - v * du2) / determinant);
  const area = Math.hypot(...cross(derivativeU, derivativeV));
  // Perpendicular distance to each UV edge, including sheared UV maps.
  const metersU = area / Math.max(EPS, Math.hypot(...derivativeV));
  const metersV = area / Math.max(EPS, Math.hypot(...derivativeU));
  if (metersU <= EPS || metersV <= EPS) return out;
  const bounded = rectangle(points, 0, 1, 0, 1);
  if (bounded.length < 3) return out;
  const bevel = Math.min(Math.max(0, decal.bevelM), Math.max(0, decal.heightM) / 2, metersU / 2, metersV / 2);
  const stops = (meters: number): number[] => {
    if (bevel <= EPS) return [0, 1];
    const w = bevel / meters;
    return [...new Set([0, w * .25, w * .5, w * .75, w, 1 - w, 1 - w * .75, 1 - w * .5, 1 - w * .25, 1])].sort((x, y) => x - y);
  };
  const xStops = stops(metersU), yStops = stops(metersV);
  const distance = (p: Point) => Math.max(0, Math.min(p.q[0] * metersU, (1 - p.q[0]) * metersU, p.q[1] * metersV, (1 - p.q[1]) * metersV));
  const displaced = (p: Point, height: number): number[] => {
    const normal = normalized(p.normal);
    return p.position.map((v, i) => v + normal[i] * height);
  };
  const emit = (vertices: Point[], heights: number[], wall = false) => {
    const positions = vertices.map((p, i) => displaced(p, heights[i]));
    const face = cross(difference(positions[1], positions[0]), difference(positions[2], positions[0]));
    if (Math.hypot(...face) <= EPS * EPS) return;
    const flat = normalized(face);
    vertices.forEach((p, i) => {
      out.positions.push(...positions[i]); out.uvs.push(...p.q);
      // Keep imported smooth normals on the planar ink; let the bevel's own geometry declare its edge.
      out.normals.push(...(wall || distance(p) < bevel - EPS ? flat : normalized(p.normal)));
    });
  };
  const qBounds = [Math.min(...bounded.map(p => p.q[0])), Math.max(...bounded.map(p => p.q[0])), Math.min(...bounded.map(p => p.q[1])), Math.max(...bounded.map(p => p.q[1]))];
  for (let x = 0; x < xStops.length - 1; x++) for (let y = 0; y < yStops.length - 1; y++) {
    if (xStops[x] > qBounds[1] || xStops[x + 1] < qBounds[0] || yStops[y] > qBounds[3] || yStops[y + 1] < qBounds[2]) continue;
    const polygon = rectangle(bounded, xStops[x], xStops[x + 1], yStops[y], yStops[y + 1]);
    for (let i = 1; i < polygon.length - 1; i++) {
      const vertices = [polygon[0], polygon[i], polygon[i + 1]];
      emit(vertices, vertices.map(p => decalSurfaceHeight(distance(p), decal.heightM, bevel)));
    }
  }
  if (decal.heightM > EPS) for (let i = 0; i < bounded.length; i++) {
    const p = bounded[i], q = bounded[(i + 1) % bounded.length];
    const onEdge = ([0, 1] as const).some(axis => [0, 1].some(edge => Math.abs(p.q[axis] - edge) < EPS && Math.abs(q.q[axis] - edge) < EPS));
    if (!onEdge) continue; // Internal source triangle edges never become walls.
    const edgeHeight = decalSurfaceHeight(0, decal.heightM, bevel);
    emit([q, p, p], [edgeHeight, edgeHeight, 0], true);
    emit([q, p, q], [edgeHeight, 0, 0], true);
  }
  return out;
}

function triangleIntersectionArea(a: number[], b: number[]): number {
  let points = [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]]];
  const orientation = Math.sign((b[2] - b[0]) * (b[5] - b[1]) - (b[3] - b[1]) * (b[4] - b[0]));
  if (!orientation) return 0;
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const side = (p: number[]) => ((b[j * 2] - b[i * 2]) * (p[1] - b[i * 2 + 1]) - (b[j * 2 + 1] - b[i * 2 + 1]) * (p[0] - b[i * 2])) * orientation;
    const clipped: number[][] = [];
    for (let k = 0; k < points.length; k++) {
      const p = points[k], q = points[(k + 1) % points.length], dp = side(p), dq = side(q);
      if (dp >= -EPS) clipped.push(p);
      if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) clipped.push(p.map((v, axis) => v + (q[axis] - v) * dp / (dp - dq)));
    }
    points = clipped;
  }
  return Math.abs(points.reduce((sum, p, i) => sum + p[0] * points[(i + 1) % points.length][1] - p[1] * points[(i + 1) % points.length][0], 0)) / 2;
}

/** Positive-area intersection only: shared edges and ordinary UV triangle diagonals are not overlap. */
export function hasUvOverlap(triangles: number[][]): boolean {
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < triangles.length; i++) {
    const a = triangles[i], candidates = new Set<number>();
    const x0 = Math.floor(Math.min(a[0], a[2], a[4]) * 16), x1 = Math.floor(Math.max(a[0], a[2], a[4]) * 16);
    const y0 = Math.floor(Math.min(a[1], a[3], a[5]) * 16), y1 = Math.floor(Math.max(a[1], a[3], a[5]) * 16);
    // Pathological tiled/out-of-range UVs remain bounded in memory and work.
    if (![x0, x1, y0, y1].every(Number.isSafeInteger) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) continue;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const key = `${x}:${y}`, bucket = buckets.get(key) || [];
      bucket.forEach(j => candidates.add(j)); bucket.push(i); buckets.set(key, bucket);
    }
    for (const j of candidates) if (triangleIntersectionArea(a, triangles[j]) > 1e-9) return true;
  }
  return false;
}
