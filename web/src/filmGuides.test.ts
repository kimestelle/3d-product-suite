import {describe, expect, it} from 'vitest';
import {PerspectiveCamera, Vector3} from 'three';
import {createCameraTargetPointerGesture, filmGateRect, filmGuideZoom, projectFilmGuide} from './filmGuides';

function camera(aspect = 16 / 9) {
  const value = new PerspectiveCamera(2 * Math.atan(18 / 50) * 180 / Math.PI, aspect, .001, 100);
  value.position.set(0, 0, 2); value.lookAt(0, 0, 0); value.updateMatrixWorld(true);
  return value;
}

describe('Film output guides', () => {
  it.each([9 / 16, 16 / 9, 1])('keeps the crop identical to the output camera for aspect %s', aspect => {
    const width = 1000, height = 620, gate = filmGateRect(width, height, aspect);
    expect(gate.width / gate.height).toBeCloseTo(aspect);
    expect(gate.x).toBeGreaterThanOrEqual(48); expect(gate.y).toBeGreaterThanOrEqual(64);
    const output = camera(aspect), overscan = camera(width / height);
    overscan.zoom = filmGuideZoom(width, height, aspect); overscan.updateProjectionMatrix();
    for (const point of [new Vector3(0, 0, 0), new Vector3(.12, -.08, .3), new Vector3(-.08, .14, -.2)]) {
      const expected = point.clone().project(output), actual = point.clone().project(overscan);
      const px = (actual.x + 1) * width / 2, py = (1 - actual.y) * height / 2;
      expect((px - gate.x) / gate.width).toBeCloseTo((expected.x + 1) / 2);
      expect((py - gate.y) / gate.height).toBeCloseTo((1 - expected.y) / 2);
    }
  });
  it('keeps margins bounded in a narrow viewport and rejects invalid geometry', () => {
    const gate = filmGateRect(100, 80, 1);
    expect(gate).toEqual({x: 34, y: 24, width: 32, height: 32});
    expect(filmGateRect(0, 500, 1)).toEqual({x: 0, y: 0, width: 0, height: 0});
    expect(filmGuideZoom(0, 500, 1)).toBe(1);
  });
  it('projects the actual target and hides behind-camera or offscreen points', () => {
    const view = camera(2), shotPosition = view.position.clone();
    const guide = projectFilmGuide(view, 800, 400, 1, new Vector3(.1, 0, 0), shotPosition, 50, true);
    expect(guide.target.x).toBeGreaterThan(400); expect(guide.target.y).toBe(200);
    expect(guide.target.visible).toBe(true); expect(guide.targetM).toEqual([.1, 0, 0]);
    expect(guide.distanceM).toBeCloseTo(Math.hypot(.1, 2)); expect(guide.inspecting).toBe(true);
    expect(projectFilmGuide(view, 800, 400, 1, new Vector3(0, 0, 3), shotPosition, 50, false).target.visible).toBe(false);
    expect(projectFilmGuide(view, 800, 400, 1, new Vector3(20, 0, 0), shotPosition, 50, false).target.visible).toBe(false);
  });
});

describe('Film target pointer plane', () => {
  it('uses the rendered projection, preserves the grab offset, and freezes camera and bounds', () => {
    const view = camera(2); view.zoom = .6; view.updateProjectionMatrix();
    const rect = {left: 20, top: 40, width: 800, height: 400};
    const target = new Vector3(0, 0, 0), start = {clientX: 430, clientY: 245};
    const gesture = createCameraTargetPointerGesture(view, rect, target, start)!;
    expect(gesture.move(start)).toEqual([0, 0, 0]);
    const next = gesture.move({clientX: 470, clientY: 225})!;
    expect(next[0]).toBeGreaterThan(0); expect(next[1]).toBeGreaterThan(0); expect(next[2]).toBeCloseTo(0);
    expect(gesture.nudge(40, -20)).toEqual(next);
    view.position.set(8, 4, 1); view.zoom = 2; view.updateProjectionMatrix(); rect.width = 200; target.set(3, 4, 5);
    expect(gesture.move({clientX: 470, clientY: 225})).toEqual(next);
    expect(gesture.move({clientX: NaN, clientY: 225})).toBeNull();
  });
  it('does not create a gesture for a hidden or unmeasurable target', () => {
    const view = camera(), rect = {left: 0, top: 0, width: 800, height: 400}, pointer = {clientX: 400, clientY: 200};
    expect(createCameraTargetPointerGesture(view, rect, new Vector3(0, 0, 3), pointer)).toBeNull();
    expect(createCameraTargetPointerGesture(view, {...rect, width: 0}, new Vector3(), pointer)).toBeNull();
  });
});
