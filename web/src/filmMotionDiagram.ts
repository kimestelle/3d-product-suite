import type {FilmMotion, MotionKind} from './filmMotion';
import {isLightTarget} from './world';

export type MotionDiagramSpec = {
  kind: MotionKind | 'pose';
  actor: 'object' | 'camera' | 'light';
  axis: FilmMotion['axis'];
  mechanism: 'lift' | 'screw';
  direction: 1 | -1;
};
type Point = [number, number];
type Vector = [number, number, number];
export type MotionDiagramPose = {subject: string; actor: string; beam: string};
const center: Point = [112, 60];
const project = ([x, y, z]: Vector): Point => [center[0] + x * .9 - z * .5, center[1] - y * .92 + (x + z) * .24];
const number = (n: number) => Number(n.toFixed(2));
const point = (p: Point) => p.map(number).join(' ');
const line = (a: Point, b: Point) => `M${point(a)}L${point(b)}`;
const polygon = (points: Point[]) => `M${points.map(point).join('L')}Z`;
const edges = [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]];
const axisIndex = {x: 0, y: 1, z: 2};

/** These are normalized diagrams, not miniature renders of the authored scene. */
export function motionDiagramSpec(scene: any, target: string, kind: MotionKind | 'pose', motion?: FilmMotion): MotionDiagramSpec {
  return {kind, actor: target === '$camera' ? 'camera' : isLightTarget(target) ? 'light' : 'object',
    axis: motion?.axis ?? 'y', mechanism: scene.actions?.find((action: any) => action.componentId === target)?.type === 'screw' ? 'screw' : 'lift',
    direction: motion && motion.amount < (kind === 'scale' ? 1 : 0) ? -1 : 1};
}

function box(position: Vector, size: Vector = [24, 28, 24], rotation = 0, axis: MotionDiagramSpec['axis'] = 'y'): string {
  const a = axisIndex[axis], u = (a + 1) % 3, v = (a + 2) % 3;
  const vertices = Array.from({length: 8}, (_, index) => {
    const p: Vector = [0,1,2].map(i => ((index >> i) & 1 ? .5 : -.5) * size[i]) as Vector;
    const first = p[u], second = p[v];
    p[u] = first * Math.cos(rotation) - second * Math.sin(rotation);
    p[v] = first * Math.sin(rotation) + second * Math.cos(rotation);
    return project(p.map((n, i) => n + position[i]) as Vector);
  });
  return edges.map(([a,b]) => line(vertices[a], vertices[b])).join('');
}
function camera(position: Point, toward: Point): string {
  const angle = Math.atan2(toward[1] - position[1], toward[0] - position[0]);
  const rotate = ([x,y]: Point): Point => [position[0] + x * Math.cos(angle) - y * Math.sin(angle), position[1] + x * Math.sin(angle) + y * Math.cos(angle)];
  return polygon([[-7,-5],[2,-5],[2,5],[-7,5]].map(p => rotate(p as Point))) + polygon([[2,-3],[7,-5],[7,5],[2,3]].map(p => rotate(p as Point)));
}
function light(position: Point): string {
  const ring = Array.from({length: 16}, (_, i): Point => [position[0] + 4 * Math.cos(i * Math.PI / 8), position[1] + 4 * Math.sin(i * Math.PI / 8)]);
  return polygon(ring) + Array.from({length: 8}, (_, i) => {
    const a = i * Math.PI / 4;
    return line([position[0] + 6 * Math.cos(a), position[1] + 6 * Math.sin(a)], [position[0] + 8 * Math.cos(a), position[1] + 8 * Math.sin(a)]);
  }).join('');
}
function beam(from: Point, target: Point): string {
  const angle = Math.atan2(target[1] - from[1], target[0] - from[0]), spread = 10;
  return polygon([from, [target[0] - Math.sin(angle) * spread, target[1] + Math.cos(angle) * spread], [target[0] + Math.sin(angle) * spread, target[1] - Math.cos(angle) * spread]]);
}

/** Stable path topology lets native SVG animation interpolate without a JS render loop. */
export function motionDiagramPose(spec: MotionDiagramSpec, progress: number): MotionDiagramPose {
  const t = Math.max(0, Math.min(1, progress)), directed = t * spec.direction;
  const origin: Vector = [0, 0, 0];
  const position: Vector = [...origin];
  let subject = box(origin), actor = '', ray = '';
  if (spec.kind === 'pose') {
    const source = project([68, 16, 8]);
    actor = spec.actor === 'light' ? light(source) : camera(source, center); ray = beam(source, center);
  } else if (spec.kind === 'orbit' || spec.kind === 'dolly') {
    const angle = -.35 + directed * 1.65;
    const source = spec.kind === 'orbit' ? project([Math.cos(angle) * 62, 16, Math.sin(angle) * 62]) : project([76 - directed * 30, 14, 8]);
    actor = spec.actor === 'light' ? light(source) : camera(source, center); ray = beam(source, center);
  } else if (spec.kind === 'aim') {
    const source = project([-58, 32, 8]);
    const aim: Vector = [0, 0, 0]; aim[axisIndex[spec.axis]] = directed * 38 - spec.direction * 19;
    actor = light(source); ray = beam(source, project(aim));
  } else if (spec.kind === 'move') {
    position[axisIndex[spec.axis]] = directed * 38 - spec.direction * 19;
    if (spec.actor === 'light') {
      const source = project([position[0] - 42, position[1] + 28, position[2]]);
      actor = light(source); ray = beam(source, center);
    } else subject = box(position);
  } else if (spec.kind === 'rotate') {
    subject = box(origin, [24, 28, 24], directed * Math.PI * .65, spec.axis);
  } else if (spec.kind === 'scale') {
    const scale = 1 + directed * .48;
    subject = box(origin, [24 * scale, 28 * scale, 24 * scale]);
  } else if (spec.kind === 'mechanical') {
    subject = box([0,-8,0], [28,24,28]);
    actor = box([0,13 + t * 30,0], [24,12,24], spec.mechanism === 'screw' ? directed * Math.PI * 1.6 : 0);
  }
  return {subject, actor, beam: ray};
}

export function motionDiagramDescription(spec: MotionDiagramSpec): string {
  const noun = spec.actor === 'camera' ? 'Camera' : spec.actor === 'light' ? 'Light' : 'Object';
  switch (spec.kind) {
    case 'pose': return `${noun} position and framing`;
    case 'move': return `${noun} moves along the ${spec.axis.toUpperCase()} axis`;
    case 'rotate': return `Object turns around its ${spec.axis.toUpperCase()} axis`;
    case 'scale': return 'Object scales uniformly around its center';
    case 'orbit': return `${noun} travels around a fixed target`;
    case 'dolly': return 'Camera travels toward its target without changing focal length';
    case 'aim': return 'Light stays in place while its aim moves';
    case 'mechanical': return spec.mechanism === 'screw' ? 'Part turns as it rises; the base stays in place' : 'Part rises along its lift axis; the base stays in place';
  }
}
