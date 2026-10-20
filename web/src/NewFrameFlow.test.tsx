import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import {addMotion} from './filmMotion';
import {FrameSetupInspector, FrameSetupObjects, frameHasInheritedMotion, nextFrameTargets, type FrameSetupProps} from './NewFrameFlow';

const noop = () => {};
function context(): FrameSetupProps {
  const scene: any = structuredClone(fixture);
  return {scene, setup: {shotId: scene.shots[0].id, stage: 'objects', targets: ['$product'], objectKind: null, objectMotionIds: [], cameraTarget: '$product', cameraKind: null, cameraMotionId: null},
    onTargets: noop, onObjectKind: noop, onCameraTarget: noop, onCameraKind: noop, onPatchMotion: noop, onStage: noop, onComplete: noop, onDiscard: noop};
}

describe('New scene rails', () => {
  it('keeps discard available when editing is disabled during an update or recovery', () => {
    const props = context(); props.disabled = true;
    const html = renderToStaticMarkup(<FrameSetupInspector {...props}/>);
    expect(html).toContain('<button type="button" class="frame-setup-discard">Discard scene</button>');
    expect(html).toMatch(/<button[^>]*class="frame-setup-next"[^>]*disabled=""/);
  });

  it('keeps whole-product and individual-part selection exclusive', () => {
    expect(nextFrameTargets(['cap', 'label'], '$product', true)).toEqual(['$product']);
    expect(nextFrameTargets(['$product'], 'cap', true)).toEqual(['cap']);
    expect(nextFrameTargets(['cap'], 'label', true)).toEqual(['cap', 'label']);
    expect(nextFrameTargets(['cap', 'label'], 'cap', false)).toEqual(['label']);
    expect(nextFrameTargets(['$product'], '$product', false)).toEqual([]);
  });

  it('selects moving objects without hiding the composition and explains anchored parts', () => {
    const props = context();
    const html = renderToStaticMarkup(<FrameSetupObjects {...props}/>);
    expect(html).toContain('Unselected objects stay visible.');
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<input[^>]*aria-label="Animate Body"[^>]*disabled=""|<input[^>]*disabled=""[^>]*aria-label="Animate Body"/);
    expect(html).toContain('Anchors Cap. Move Whole product to keep them together.');
  });

  it('never promises a still product when existing across-cut motion is retained', () => {
    const props = context(), html = renderToStaticMarkup(<FrameSetupInspector {...props}/>);
    expect(frameHasInheritedMotion(props.scene)).toBe(true);
    expect(html).toContain('No added motion');
    expect(html).toContain('Across-cut animation continues.');
    expect(html).not.toContain('Keep still');
    props.scene.actions = [];
    const still = renderToStaticMarkup(<FrameSetupInspector {...props}/>);
    expect(still).toContain('Keep still');
    expect(still).not.toContain('Across-cut animation continues.');
  });

  it('shows precise values for the selected object motion and keeps camera as the next decision', () => {
    const props = context();
    props.setup.objectKind = 'move';
    props.setup.objectMotionIds = [addMotion(props.scene, props.setup.shotId, '$product', 'move')];
    const html = renderToStaticMarkup(<FrameSetupInspector {...props}/>);
    for (const label of ['New scene motion amount', 'New scene motion axis', 'New scene motion duration', 'New scene motion easing']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('>mm<');
    expect(html).toContain('Next: camera');
    expect(html).not.toContain('Finish scene');
    expect(html).toContain('Discard scene');
  });

  it('offers camera aiming separately from object motion and describes a fixed start target', () => {
    const props = context(); props.setup.stage = 'camera'; props.setup.cameraTarget = 'cap';
    const left = renderToStaticMarkup(<FrameSetupObjects {...props}/>);
    const right = renderToStaticMarkup(<FrameSetupInspector {...props}/>);
    expect(left).toContain('type="radio"');
    expect(left).toContain('aria-label="Aim at Cap"');
    expect(left).not.toMatch(/<input[^>]*aria-label="Aim at Body"[^>]*disabled=""/);
    expect(right).toContain('Aim is set at the scene’s start.');
    expect(right).toContain('Orbit');
    expect(right).toContain('Push in');
    expect(right).toContain('Finish scene');
    expect(right).toContain('>Back<');
    expect(right).not.toContain('Next: camera');
  });
});
