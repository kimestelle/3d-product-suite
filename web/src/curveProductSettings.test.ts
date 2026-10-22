import {describe,expect,it} from 'vitest';
import {DEFAULT_PRODUCT_SETTINGS,normalizeProductSettings,readProductSettings,serializeProductSettings,updateProductSettings} from './curveProductSettings';
describe('product mesh study settings',()=>{
  it('keeps independent recoverable settings for each frame',()=>{
    const original=readProductSettings(null),edited=updateProductSettings(original,'radial',{mode:'wireframe',opacity:.1,edges:.8,backEdges:true});
    expect(original.radial).toEqual(DEFAULT_PRODUCT_SETTINGS);expect(original.current).not.toBe(original.radial);
    expect(edited.current).toBe(original.current);expect(readProductSettings(serializeProductSettings(edited))).toEqual(edited);
    expect(serializeProductSettings(original)).toBe('');
  });
  it('clamps numeric inputs without propagating NaN or invalid modes',()=>{
    expect(normalizeProductSettings({mode:'wireframe',opacity:-1,edges:2,backEdges:true})).toEqual({mode:'wireframe',opacity:0,edges:1,backEdges:true});
    expect(normalizeProductSettings({mode:'mesh',opacity:Infinity,edges:'1',backEdges:'yes'})).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(readProductSettings('c:wireframe,,NaN,0;s:translucent,.5,.3,1').current.opacity).toBe(.18);
    expect(readProductSettings('x'.repeat(513))).toEqual(readProductSettings(null));
  });
  it('migrates old overlay choices without treating cell size as a geometry control',()=>{
    const next=readProductSettings(null,'c:mesh,.9,.8,96;s:translucent,1,.5,24;r:clear,.8,.5,80');
    expect(next.current).toEqual({...DEFAULT_PRODUCT_SETTINGS,mode:'wireframe'});
    expect(next.sdf).toEqual({...DEFAULT_PRODUCT_SETTINGS,mode:'translucent'});
    expect(next.radial).toEqual(DEFAULT_PRODUCT_SETTINGS);
    expect(readProductSettings('c:solid,.4,.2,0','c:mesh,1,1,96').current.mode).toBe('solid');
  });
});
