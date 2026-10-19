import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import ExportPanel, {type ExportPanelProps} from './ExportPanel';
const props: ExportPanelProps = {
  scene: {render: {width: 1080, height: 1920, fps: 24, samples: 32}, shots: [{endFrame: 360}]},
  projectName: 'Lamp campaign', frame: 125, initialMode: 'still', capabilities: {blenderAvailable: true, ffmpegAvailable: true}, jobs: [], currentDigest: 'current',
  onSubmit: async () => {throw new Error('render should only start from an explicit submit');}, onControl: async () => {}, onClose: () => {}, onAdjustFrame: () => {},
};
describe('Export sheet content', () => {
  it('separates selecting export settings from rendering and exposes all still formats', () => {
    const html = renderToStaticMarkup(<ExportPanel {...props}/>);
    expect(html).toContain('<dialog'); expect(html).toContain('Render still');
    for (const label of ['PNG', 'JPEG', 'WebP', 'Current composition', '1080 × 1920 px', 'Frame 125 of 360', 'Filename']) expect(html).toContain(label);
    expect(html).not.toContain('<canvas'); expect(html).not.toContain('<img');
    expect(html).not.toContain('Download PNG');
  });
  it('explains full-film video scope and offers the actual three supported handoff types', () => {
    const html = renderToStaticMarkup(<ExportPanel {...props} initialMode="video"/>);
    for (const label of ['MP4', 'ProRes 422', 'PNG frames', '15 s · 24 fps · 360 frames', '.mp4', 'Render video']) expect(html).toContain(label);
    expect(html).not.toContain('JPEG');
  });
  it('keeps output settings visible when local tools are missing and disables the actual render action', () => {
    const html = renderToStaticMarkup(<ExportPanel {...props} capabilities={{blenderAvailable:false, blenderIssue:'Blender executable was not found'}}/>);
    expect(html).toContain('Blender executable was not found');
    expect(html).toContain('disabled="">Render still');
    expect(html).toContain('Current composition');
  });
  it('limits paired export settings to the formats the comparison bundle supports', () => {
    const html = renderToStaticMarkup(<ExportPanel {...props} scene={{...props.scene, comparison:{}}}/>);
    expect(html).toContain('Both environments'); expect(html).toContain('matching PNG stills');
    expect(html).not.toContain('JPEG'); expect(html).not.toContain('WebP');
  });
});
