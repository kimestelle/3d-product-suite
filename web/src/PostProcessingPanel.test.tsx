import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import PostProcessingPanel from './PostProcessingPanel';
describe('image finish controls',()=>{
  it('starts neutral with every manual control disabled, and no invented auto analysis',()=>{
    const html=renderToStaticMarkup(<PostProcessingPanel scene={{}} onChange={vi.fn()}/>);
    expect(html).toContain('aria-label="Post-processing"');expect(html).toContain('aria-label="Enable post-processing"');
    expect(html).toContain('Open a loaded scene preview');expect(html).toContain('aria-label="Image exposure"');
    expect(html).toContain('value="0"');expect(html).toContain('Effects');expect(html).toContain('Reset');expect(html).toContain('Switch off to compare');
  });
  it('shows saved knobs and an available auto-balance action without mutating the scene on render',()=>{
    const scene={postProcessing:{enabled:true,exposureEV:.4,contrast:1.1}},before=structuredClone(scene);
    const html=renderToStaticMarkup(<PostProcessingPanel scene={scene} onChange={vi.fn()} analyzePostProcessing={vi.fn()}/>);
    expect(html).toContain('value="0.4"');expect(html).toContain('value="110"');expect(html).toContain('Auto balance');expect(scene).toEqual(before);
  });
  it('keeps saved settings visible while disabling every edit until the current preview is ready',()=>{
    const html=renderToStaticMarkup(<PostProcessingPanel scene={{postProcessing:{enabled:true,exposureEV:.4}}} onChange={vi.fn()} analyzePostProcessing={vi.fn()} ready={false}/>);
    expect(html).toContain('value="0.4"');
    for(const control of html.match(/<(?:input|button)\b[^>]*>/g)??[])expect(control).toContain('disabled=""');
    expect(html).toContain('disabled="">Auto balance');expect(html).toContain('disabled="">Reset');
  });
});
