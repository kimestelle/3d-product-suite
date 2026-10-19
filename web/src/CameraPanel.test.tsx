import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import CameraPanel from './CameraPanel';

describe('trimmed camera source controls', () => {
  it('shows the visible pose and blocks unavailable source-end spatial edits', () => {
    const scene: any = structuredClone(fixture), shot = scene.shots[0];
    shot.camera.durationFrames = 240;
    const sample = {frame: shot.endFrame, shotId: shot.id, camera: {positionM: [.123, .456, .789], targetM: [0, .1, 0], focalLengthMm: 73}};
    const html = renderToStaticMarkup(<CameraPanel scene={scene} frame={shot.endFrame} cameraEnd="to" samples={[sample]} onChange={vi.fn()} onFrame={vi.fn()}/>);
    expect(html).toContain('Source end · trimmed');
    expect(html).toContain('Camera source end (frame 240) is outside this shot.');
    expect(html).toContain('<fieldset class="film-camera-fields" disabled="">');
    expect(html).toMatch(/aria-label="Frame position X"[^>]*value="123"/);
    expect(html).toMatch(/aria-label="Focal length"[^>]*value="73"/);
    expect(html).not.toMatch(/aria-label="Focal length"[^>]*disabled=""/);
    expect(html).toContain('<button type="button" disabled="">Both ends</button>');
    expect(html).toContain('<button type="button" disabled="">Move closer</button>');
  });
  it('shows the saved part name while keeping the camera target bound to its immutable ID', () => {
    const scene: any = structuredClone(fixture);
    scene.editorPartNames = {cap: 'Orange cap'};
    const before = structuredClone(scene);
    const html = renderToStaticMarkup(<CameraPanel scene={scene} frame={1} cameraEnd="from" onChange={vi.fn()} onFrame={vi.fn()}/>);
    expect(html).toContain('<option value="cap">Orange cap</option>');
    expect(scene).toEqual(before);
  });
  it('leaves the visible source start editable after trimming', () => {
    const scene: any = structuredClone(fixture); scene.shots[0].camera.durationFrames = 240;
    const html = renderToStaticMarkup(<CameraPanel scene={scene} frame={1} cameraEnd="from" onChange={vi.fn()} onFrame={vi.fn()}/>);
    expect(html).not.toContain('<fieldset class="film-camera-fields" disabled="">');
    expect(html).toContain('aria-label="Start position X"');
  });
});
