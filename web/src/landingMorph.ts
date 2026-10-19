export type AperturePoint = {x: number; y: number};
/** Absolute SVG coordinates; each anchor owns its incoming and outgoing handles. */
export type ApertureNode = {point: AperturePoint; in: AperturePoint; out: AperturePoint};
type Point = AperturePoint;
type BoundaryPoint = {point: Point; derivative: Point};
type Edge = {start: Point; control?: Point; end: Point};

const CENTER = {x: 500, y: 300};
export const APERTURE_NODE_COUNT = 64;
const SEGMENTS = APERTURE_NODE_COUNT;
const ANGLE = Math.PI * 2 / SEGMENTS;
// The circular arc handle ratio also preserves shared tangents during the morph.
const HANDLE = 4 / 3 * Math.tan(ANGLE / 4);
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const mix = (a: Point, b: Point, t: number): Point => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});

export function clampLandingProgress(progress: number): number {
  return Number.isNaN(progress) ? 0 : Math.max(0, Math.min(1, progress));
}

function smoothstep(t: number): number { return t * t * (3 - 2 * t); }

function roundedXEdges(): Edge[] {
  const vertices: Point[] = [
    {x: 0, y: -135}, {x: 145, y: -270}, {x: 290, y: -135},
    {x: 145, y: 0}, {x: 290, y: 135}, {x: 145, y: 270},
    {x: 0, y: 135}, {x: -145, y: 270}, {x: -290, y: 135},
    {x: -145, y: 0}, {x: -290, y: -135}, {x: -145, y: -270},
  ];
  const trim = 52, edgeLength = Math.hypot(145, 135);
  // Rounding retracts the extremities. Restore the requested 580 × 540 bounds.
  const scaleX = 290 / (290 - trim * 145 / edgeLength / 2);
  const scaleY = 270 / (270 - trim * 135 / edgeLength / 2);
  const scale = (point: Point): Point => ({x: point.x * scaleX, y: point.y * scaleY});
  const towards = (a: Point, b: Point): Point => mix(a, b, trim / Math.hypot(b.x - a.x, b.y - a.y));
  const corners = vertices.map((point, index) => ({
    start: scale(towards(point, vertices[(index + vertices.length - 1) % vertices.length])),
    control: scale(point),
    end: scale(towards(point, vertices[(index + 1) % vertices.length])),
  }));
  return corners.flatMap((corner, index) => [corner, {start: corner.end, end: corners[(index + 1) % corners.length].start}]);
}

const X_EDGES = roundedXEdges();

function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-9) return Math.abs(b) < 1e-9 ? [] : [-c / b];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-8) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

function radialDerivative(point: Point, tangent: Point, direction: Point): Point {
  const radius = dot(point, direction);
  const perpendicular = {x: -direction.y, y: direction.x};
  const change = radius * dot(tangent, direction) / dot(tangent, perpendicular);
  return {x: change * direction.x + radius * perpendicular.x, y: change * direction.y + radius * perpendicular.y};
}

function xBoundary(angle: number): BoundaryPoint {
  const direction = {x: Math.cos(angle), y: Math.sin(angle)};
  let hit: BoundaryPoint | undefined;
  let farthest = -Infinity;
  for (const edge of X_EDGES) {
    const control = edge.control ?? mix(edge.start, edge.end, .5);
    const a = {x: edge.start.x - 2 * control.x + edge.end.x, y: edge.start.y - 2 * control.y + edge.end.y};
    const b = {x: 2 * (control.x - edge.start.x), y: 2 * (control.y - edge.start.y)};
    for (const root of quadraticRoots(cross(a, direction), cross(b, direction), cross(edge.start, direction))) {
      if (root < -1e-8 || root > 1 + 1e-8) continue;
      const t = Math.max(0, Math.min(1, root));
      const point = {x: a.x * t * t + b.x * t + edge.start.x, y: a.y * t * t + b.y * t + edge.start.y};
      const radius = dot(point, direction);
      if (radius <= farthest || radius <= 0) continue;
      const tangent = {x: 2 * a.x * t + b.x, y: 2 * a.y * t + b.y};
      hit = {point, derivative: radialDerivative(point, tangent, direction)};
      farthest = radius;
    }
  }
  if (!hit) throw new Error('The rounded X boundary must intersect every outward ray.');
  return hit;
}

function circleBoundary(angle: number): BoundaryPoint {
  return {point: {x: 260 * Math.cos(angle), y: 260 * Math.sin(angle)}, derivative: {x: -260 * Math.sin(angle), y: 260 * Math.cos(angle)}};
}

function rectangleBoundary(angle: number): BoundaryPoint {
  const direction = {x: Math.cos(angle), y: Math.sin(angle)};
  const ax = Math.abs(direction.x), ay = Math.abs(direction.y);
  const sx = Math.sign(direction.x), sy = Math.sign(direction.y);
  const width = 468, height = 270, radius = 95;
  const corner = {x: width - radius, y: height - radius};
  let distance: number;
  let tangent: Point;
  if (ax > 1e-9 && width * ay / ax <= corner.y) {
    distance = width / ax; tangent = {x: 0, y: sx};
  } else if (ay > 1e-9 && height * ax / ay <= corner.x) {
    distance = height / ay; tangent = {x: -sy, y: 0};
  } else {
    const projection = ax * corner.x + ay * corner.y;
    distance = projection + Math.sqrt(Math.max(0, projection * projection - dot(corner, corner) + radius * radius));
    const normal = {x: direction.x * distance - sx * corner.x, y: direction.y * distance - sy * corner.y};
    tangent = {x: -normal.y, y: normal.x};
  }
  const point = {x: direction.x * distance, y: direction.y * distance};
  const derivative = radialDerivative(point, tangent, direction);
  // A sample straddling the arc/straight join must not bow outside the frame.
  // Scale both handles together so the shared tangent remains continuous.
  const xLimit = Math.abs(derivative.x) < 1e-8 ? 1 : Math.max(0, width - Math.abs(point.x)) / (Math.abs(derivative.x) * HANDLE);
  const yLimit = Math.abs(derivative.y) < 1e-8 ? 1 : Math.max(0, height - Math.abs(point.y)) / (Math.abs(derivative.y) * HANDLE);
  const limit = Math.min(1, xLimit, yLimit);
  return {point, derivative: {x: derivative.x * limit, y: derivative.y * limit}};
}

const X = Array.from({length: SEGMENTS}, (_, index) => xBoundary(index * ANGLE));
const CIRCLE = Array.from({length: SEGMENTS}, (_, index) => circleBoundary(index * ANGLE));
const RECTANGLE = Array.from({length: SEGMENTS}, (_, index) => rectangleBoundary(index * ANGLE));
const format = (value: number) => (Math.round(value * 1000) / 1000).toString();
const coordinates = (point: Point) => `${format(point.x + CENTER.x)} ${format(point.y + CENTER.y)}`;

function morphBoundary(progress: number): BoundaryPoint[] {
  const value = clampLandingProgress(progress);
  const from = value <= .5 ? X : CIRCLE;
  const to = value <= .5 ? CIRCLE : RECTANGLE;
  const amount = smoothstep(value <= .5 ? value * 2 : (value - .5) * 2);
  return from.map((entry, index) => ({point: mix(entry.point, to[index].point, amount), derivative: mix(entry.derivative, to[index].derivative, amount)}));
}

/** The same perimeter as landingMorphPath, with editable absolute cubic handles. */
export function landingMorphNodes(progress: number): ApertureNode[] {
  return morphBoundary(progress).map(({point, derivative}) => ({
    point: {x: point.x + CENTER.x, y: point.y + CENTER.y},
    in: {x: point.x - derivative.x * HANDLE + CENTER.x, y: point.y - derivative.y * HANDLE + CENTER.y},
    out: {x: point.x + derivative.x * HANDLE + CENTER.x, y: point.y + derivative.y * HANDLE + CENTER.y},
  }));
}

/** A continuous closed cubic path: rounded X → circle → rounded rectangle. */
export function landingMorphPath(progress: number): string {
  const points = morphBoundary(progress);
  let path = `M ${coordinates(points[0].point)}`;
  for (let index = 0; index < SEGMENTS; index++) {
    const start = points[index], end = points[(index + 1) % SEGMENTS];
    const first = {x: start.point.x + start.derivative.x * HANDLE, y: start.point.y + start.derivative.y * HANDLE};
    const second = {x: end.point.x - end.derivative.x * HANDLE, y: end.point.y - end.derivative.y * HANDLE};
    path += ` C ${coordinates(first)} ${coordinates(second)} ${coordinates(end.point)}`;
  }
  return `${path} Z`;
}
