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


describe('Camera sidebar hierarchy', () => {
  const render = (props: Partial<React.ComponentProps<typeof CameraPanel>> = {}) => renderToStaticMarkup(<CameraPanel scene={structuredClone(fixture)} frame={1} embedded onChange={vi.fn()} onFrame={vi.fn()} {...props}/>);
  it('keeps framing essentials available and exact coordinates in closed disclosures', () => {
    const html = render({viewportControls: true});
    for (const label of ['Camera aspect ratio', 'Focal length', 'Target', 'Depth of field']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('gesso-camera-position');
    expect(html).not.toContain('gesso-camera-position" open');
    expect(html).not.toContain('gesso-camera-advanced" open');
    expect(html.indexOf('aria-label="Focal length"')).toBeLessThan(html.indexOf('gesso-camera-position'));
    expect(html).not.toContain('aria-label="Camera aperture"');
    expect(html).not.toContain('Depth of field is controlled on the image');
  });
  it('shows only the focus controls needed for the current optical mode', () => {
    const scene: any = structuredClone(fixture);
    scene.shots[0].camera.depthOfField = {enabled: true, fStop: 4};
    const following = render({scene});
    expect(following).toMatch(/aria-label="Camera aperture"[^>]*value="4"/);
    expect(following).toContain('aria-label="Focus mode"');
    expect(following).not.toContain('aria-label="Camera focus distance"');
    scene.shots[0].camera.depthOfField.focusDistanceM = .75;
    expect(render({scene})).toMatch(/aria-label="Camera focus distance"[^>]*value="750"/);
  });
  it('blocks motion-owned spatial edits while leaving framing optics editable', () => {
    const scene: any = structuredClone(fixture);
    scene.shots[0].camera.depthOfField = {enabled: true, fStop: 4, focusDistanceM: .75};
    const html = render({scene, cameraMotionDriven: true});
    expect(html).toContain('<fieldset class="film-camera-fields" disabled="">');
    expect(html).toMatch(/aria-label="Target"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Aim at start"[^>]*disabled=""/);
    expect(html).toContain('<button type="button" disabled="">Reverse</button>');
    for (const label of ['Focal length', 'Camera aperture', 'Camera focus distance', 'Camera aspect ratio', 'Depth of field']) expect(html).not.toMatch(new RegExp(`aria-label="${label}"[^>]*disabled=""`));
  });
  it('keeps the visible still framing without endpoint controls', () => {
    const html = render({mode: 'still'});
    expect(html).not.toContain('aria-label="Camera endpoint"');
    expect(html).toContain('aria-label="Focal length"');
    expect(html).toContain('aria-label="Frame position X"');
    expect(html).toContain('Video motion is preserved.');
  });
});
