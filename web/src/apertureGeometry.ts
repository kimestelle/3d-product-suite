import {APERTURE_NODE_COUNT, type ApertureNode, type AperturePoint} from './landingMorph';

export type ApertureHandle = 'in' | 'out';
export type ApertureHandleMode = 'free' | 'aligned' | 'symmetric';
export const APERTURE_EDIT_BOUNDS = Object.freeze({minX: 0, minY: 0, maxX: 1000, maxY: 600});
const {minX, minY, maxX, maxY} = APERTURE_EDIT_BOUNDS;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const format = (value: number) => (Math.round(value * 1000) / 1000).toString();
const coordinates = (point: AperturePoint) => `${format(point.x)} ${format(point.y)}`;

function readPoint(value: unknown): AperturePoint {
  if (!value || typeof value !== 'object') throw new Error('Each anchor and handle needs x and y coordinates.');
  const {x, y} = value as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('All aperture coordinates must be finite numbers.');
  }
  if (x < minX || x > maxX || y < minY || y > maxY) {
    throw new Error('Aperture coordinates must stay within 1000 × 600.');
  }
  return {x, y};
}

/** Validate imported data and copy only the geometry fields, never caller-owned objects. */
export function cloneApertureNodes(value: unknown): ApertureNode[] {
  if (!Array.isArray(value) || value.length !== APERTURE_NODE_COUNT) {
    throw new Error(`An aperture needs exactly ${APERTURE_NODE_COUNT} anchors.`);
  }
  // Array.from also visits missing array entries instead of silently preserving holes.
  return Array.from(value, entry => {
    if (!entry || typeof entry !== 'object') throw new Error('Each aperture anchor needs point, in, and out coordinates.');
    return {point: readPoint(entry.point), in: readPoint(entry.in), out: readPoint(entry.out)};
  });
}

export function parseApertureNodes(json: string): ApertureNode[] {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error('The aperture file must contain valid JSON.'); }
  return cloneApertureNodes(value);
}

/** The last cubic returns to the first anchor; an imported path can never become open. */
export function aperturePath(nodes: readonly ApertureNode[]): string {
  const points = cloneApertureNodes(nodes);
  let path = `M ${coordinates(points[0].point)}`;
  for (let index = 0; index < points.length; index++) {
    const start = points[index], end = points[(index + 1) % points.length];
    path += ` C ${coordinates(start.out)} ${coordinates(end.in)} ${coordinates(end.point)}`;
  }
  return `${path} Z`;
}

function editableNode(nodes: readonly ApertureNode[], index: number): {result: ApertureNode[]; node: ApertureNode} {
  if (!Number.isInteger(index) || index < 0 || index >= APERTURE_NODE_COUNT) {
    throw new Error('Choose an existing aperture anchor.');
  }
  const result = cloneApertureNodes(nodes);
  return {result, node: result[index]};
}

function boundedTarget(target: AperturePoint, previous: AperturePoint): AperturePoint {
  return {
    x: clamp(Number.isFinite(target.x) ? target.x : previous.x, minX, maxX),
    y: clamp(Number.isFinite(target.y) ? target.y : previous.y, minY, maxY),
  };
}

/** Move the anchor and both handles together, preserving their relative vectors. */
export function moveApertureAnchor(nodes: readonly ApertureNode[], index: number, target: AperturePoint): ApertureNode[] {
  const {result, node} = editableNode(nodes, index);
  const next = boundedTarget(target, node.point), points = [node.point, node.in, node.out];
  const dx = clamp(next.x - node.point.x, minX - Math.min(...points.map(point => point.x)), maxX - Math.max(...points.map(point => point.x)));
  const dy = clamp(next.y - node.point.y, minY - Math.min(...points.map(point => point.y)), maxY - Math.max(...points.map(point => point.y)));
  for (const point of points) { point.x = clamp(point.x + dx, minX, maxX); point.y = clamp(point.y + dy, minY, maxY); }
  return result;
}

/** Largest distance that a normalized ray can travel inside the edit bounds. */
function rayLimit(origin: AperturePoint, direction: AperturePoint): number {
  const x = direction.x > 0 ? (maxX - origin.x) / direction.x : direction.x < 0 ? (minX - origin.x) / direction.x : Infinity;
  const y = direction.y > 0 ? (maxY - origin.y) / direction.y : direction.y < 0 ? (minY - origin.y) / direction.y : Infinity;
  return Math.max(0, Math.min(x, y));
}

function onRay(origin: AperturePoint, direction: AperturePoint, distance: number): AperturePoint {
  return {x: clamp(origin.x + direction.x * distance, minX, maxX), y: clamp(origin.y + direction.y * distance, minY, maxY)};
}

/** Free handles move independently; aligned preserves the opposite length; symmetric mirrors it. */
export function moveApertureHandle(
  nodes: readonly ApertureNode[], index: number, handle: ApertureHandle, target: AperturePoint, mode: ApertureHandleMode = 'free',
): ApertureNode[] {
  if (handle !== 'in' && handle !== 'out') throw new Error('Choose the incoming or outgoing handle.');
  if (mode !== 'free' && mode !== 'aligned' && mode !== 'symmetric') throw new Error('Choose a valid handle mode.');
  const {result, node} = editableNode(nodes, index);
  const opposite = handle === 'in' ? 'out' : 'in';
  const next = boundedTarget(target, node[handle]);
  node[handle] = next;
  if (mode === 'free') return result;
  const dx = next.x - node.point.x, dy = next.y - node.point.y, distance = Math.hypot(dx, dy);
  if (distance === 0) {
    if (mode === 'symmetric') node[opposite] = {...node.point};
    return result;
  }
  const direction = {x: dx / distance, y: dy / distance}, reverse = {x: -direction.x, y: -direction.y};
  const oppositeLength = Math.hypot(node[opposite].x - node.point.x, node[opposite].y - node.point.y);
  const reverseLimit = rayLimit(node.point, reverse);
  if (mode === 'symmetric') {
    const length = Math.min(distance, reverseLimit);
    node[handle] = onRay(node.point, direction, length);
    node[opposite] = onRay(node.point, reverse, length);
  } else {
    node[opposite] = onRay(node.point, reverse, Math.min(oppositeLength, reverseLimit));
  }
  return result;
}
