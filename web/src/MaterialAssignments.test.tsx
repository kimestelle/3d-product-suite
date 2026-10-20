import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import MaterialAssignments from './MaterialAssignments';
import {sceneParts} from './hierarchy';
import {campaignMaterialPresets} from './materialPresets';

describe('material assignment library',()=>{
  it('shows a one-column material tree with native edit, attach and object buttons',()=>{
    const scene=structuredClone(fixture),presets=campaignMaterialPresets(scene),parts=sceneParts(scene);
    const html=renderToStaticMarkup(<MaterialAssignments scene={scene} presets={presets} parts={parts}
      onEdit={()=>{}} onDuplicate={()=>{}} onDelete={()=>{}} onSelect={()=>{}} onChange={()=>{}}/>);
    expect(html).toContain('gesso-material-swatches is-list');
    expect(html.match(/draggable="true"/g)).toHaveLength(4);
    for(const preset of presets) {
      expect(html).toContain(`aria-label="${preset.name}"`);
      expect(html).toContain(`aria-label="Attach objects to ${preset.name}"`);
      expect(html).toContain(`aria-label="Objects using ${preset.name}"`);
      expect(html).toContain(`aria-label="Material options: ${preset.name}"`);
    }
    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).not.toContain('Original materials');
    // The action trigger is a native sibling, so it never invokes the swatch's editor.
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(presets.length);
    expect(html).not.toMatch(/<button[^>]*class="gesso-material-swatch"[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });
});
