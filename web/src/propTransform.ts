import {Quaternion, Scene, Vector3, type Object3D, type PerspectiveCamera, type WebGLRenderer} from 'three';
import {TransformControls, type TransformControlsMode} from 'three/addons/controls/TransformControls.js';

export type PropTransformMode = TransformControlsMode;
type Vec3 = [number, number, number];
export type PropTransformEdit =
  | {id: string; mode: 'translate'; translationM: Vec3}
  | {id: string; mode: 'rotate'; rotationXyzw: [number, number, number, number]}
  | {id: string; mode: 'scale'; sizeM: Vec3};
export type PropTransformCommit = (edit: PropTransformEdit) => boolean | void;

type Target = {
  id: string;
  object: Object3D;
  mode: PropTransformMode;
  sizeM: Vec3;
  cylinder: boolean;
  yawOnly: boolean;
  onCommit: PropTransformCommit;
};
type Drag = {
  pointer: number;
  position: Vector3;
  rotation: Quaternion;
  scale: Vector3;
};

/** Draw the editor controls as a separate pass, outside the scene and snapshots. */
export class PropTransform {
  private readonly overlay = new Scene();
  private readonly controls: TransformControls;
  private target: Target | null = null;
  private drag: Drag | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, camera: PerspectiveCamera,
    private readonly invalidate: () => void, private readonly onDragChanged: () => void) {
    // Claim only pointer events that hit the gizmo. TransformControls' default
    // DOM listener takes pointer capture even when there is no hit.
    this.controls = new TransformControls(camera, canvas.ownerDocument.createElement('div'));
    this.controls.setSize(.72);
    this.overlay.add(this.controls.getHelper());
    this.controls.addEventListener('change', this.invalidate);
    canvas.addEventListener('pointerdown', this.down, true);
    canvas.addEventListener('pointermove', this.move, true);
    canvas.addEventListener('pointerup', this.up, true);
    canvas.addEventListener('pointercancel', this.lost, true);
    canvas.addEventListener('lostpointercapture', this.lost);
    window.addEventListener('keydown', this.escape, true);
    window.addEventListener('blur', this.cancel);
  }

  get dragging(): boolean { return this.drag !== null; }
  get draggedObject(): Object3D | undefined { return this.drag ? this.target?.object : undefined; }

  setTarget(target: Target | null): void {
    if (this.target?.object === target?.object && this.target?.mode === target?.mode
        && this.target?.yawOnly === target?.yawOnly) {
      this.target = target;
      return;
    }
    this.cancel();
    this.target = target;
    if (!target) { this.controls.detach(); return; }
    this.controls.setMode(target.mode);
    this.controls.setSpace(target.mode === 'scale' ? 'local' : 'world');
    this.controls.showX = !target.yawOnly;
    this.controls.showZ = !target.yawOnly;
    this.controls.attach(target.object);
  }

  private pointer(event: PointerEvent, button: number): PointerEvent | null {
    const {left, top, width, height} = this.canvas.getBoundingClientRect();
    if (!width || !height) return null;
    // TransformControls expects normalized coordinates here. Its declaration
    // uses the DOM PointerEvent type for this internal pointer payload.
    return {x: (event.clientX - left) / width * 2 - 1, y: 1 - (event.clientY - top) / height * 2, button} as PointerEvent;
  }

  private down = (event: PointerEvent): void => {
    const target = this.target;
    if (!target || this.drag || !event.isPrimary || event.button !== 0) return;
    const pointer = this.pointer(event, 0);
    if (!pointer) return;
    target.object.updateWorldMatrix(true, false);
    this.controls.camera.updateMatrixWorld(true);
    this.overlay.updateMatrixWorld(true);
    this.controls.pointerHover(pointer);
    if (!this.controls.axis || target.yawOnly && this.controls.axis !== 'Y') return;
    // The manipulation plane depends on the selected axis.
    this.overlay.updateMatrixWorld(true);
    this.controls.pointerDown(pointer);
    if (!this.controls.dragging) return;
    const {object} = target;
    this.drag = {
      pointer: event.pointerId, position: object.position.clone(),
      rotation: object.quaternion.clone(), scale: object.scale.clone(),
    };
    event.preventDefault();
    event.stopImmediatePropagation();
    try { this.canvas.setPointerCapture(event.pointerId); }
    catch { this.cancel(); return; }
    this.onDragChanged();
  };

  private move = (event: PointerEvent): void => {
    const target = this.target;
    if (!target) return;
    const pointer = this.pointer(event, -1);
    if (!pointer) return;
    const drag = this.drag;
    if (!drag) {
      if (event.buttons === 0 && (event.pointerType === 'mouse' || event.pointerType === 'pen')) {
        this.overlay.updateMatrixWorld(true);
        this.controls.pointerHover(pointer);
      }
      return;
    }
    if (drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.controls.pointerMove(pointer);
    const {object} = target;
    if (!object.position.toArray().every(Number.isFinite) || !object.quaternion.toArray().every(Number.isFinite)
        || !object.scale.toArray().every(Number.isFinite)) {
      this.cancel();
      return;
    }
    if (target.mode === 'scale') {
      const factor = object.scale.clone().divide(drag.scale);
      for (const axis of [0, 1, 2]) factor.setComponent(axis, Math.max(.001 / target.sizeM[axis], factor.getComponent(axis)));
      if (target.cylinder) {
        const radius = this.controls.axis?.includes('X') ? factor.x : factor.z;
        factor.x = factor.z = radius;
      }
      object.scale.copy(drag.scale).multiply(factor);
    }
  };

  private up = (event: PointerEvent): void => {
    const target = this.target, drag = this.drag;
    if (!target || !drag || drag.pointer !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const {id, mode, object, sizeM} = target;
    let edit: PropTransformEdit | undefined;
    if (mode === 'translate' && !object.position.equals(drag.position)) {
      edit = {id, mode, translationM: object.position.toArray()};
    } else if (mode === 'rotate' && !object.quaternion.equals(drag.rotation)) {
      edit = {id, mode, rotationXyzw: object.quaternion.toArray()};
    } else if (mode === 'scale' && !object.scale.equals(drag.scale)) {
      edit = {id, mode, sizeM: object.scale.clone().divide(drag.scale).multiply(new Vector3(...sizeM)).toArray()};
    }
    try {
      if (!edit || target.onCommit(edit) === false) this.restore(target, drag);
    } catch (error) {
      this.restore(target, drag);
      throw error;
    } finally { this.end(drag); }
  };

  private restore(target: Target, drag: Drag): void {
    target.object.position.copy(drag.position);
    target.object.quaternion.copy(drag.rotation);
    target.object.scale.copy(drag.scale);
  }

  private end(drag: Drag): void {
    this.drag = null;
    this.controls.pointerUp(null);
    if (this.canvas.hasPointerCapture(drag.pointer)) this.canvas.releasePointerCapture(drag.pointer);
    this.onDragChanged();
    this.invalidate();
  }

  cancel = (): void => {
    if (!this.drag || !this.target) return;
    this.restore(this.target, this.drag);
    this.end(this.drag);
  };

  private lost = (event: PointerEvent): void => {
    if (event.pointerId === this.drag?.pointer) this.cancel();
  };

  private escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.drag) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.cancel();
  };

  render(renderer: WebGLRenderer, camera: PerspectiveCamera): void {
    if (!this.target) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try { renderer.render(this.overlay, camera); }
    finally { renderer.autoClear = autoClear; }
  }

  dispose(): void {
    this.cancel();
    this.controls.removeEventListener('change', this.invalidate);
    this.controls.dispose();
    this.overlay.clear();
    this.canvas.removeEventListener('pointerdown', this.down, true);
    this.canvas.removeEventListener('pointermove', this.move, true);
    this.canvas.removeEventListener('pointerup', this.up, true);
    this.canvas.removeEventListener('pointercancel', this.lost, true);
    this.canvas.removeEventListener('lostpointercapture', this.lost);
    window.removeEventListener('keydown', this.escape, true);
    window.removeEventListener('blur', this.cancel);
  }
}
