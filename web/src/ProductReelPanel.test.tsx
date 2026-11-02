import {describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import fixture from '../../examples/bottle.scene.json';
import ExportSetupPanel from './ExportSetupPanel';
import {productReelSettings} from './productReel';
describe('product reel side panel',()=>{
  const props=()=>({sourceScene:fixture,tab:'random' as const,onTab:vi.fn(),settings:productReelSettings(fixture),onSettings:vi.fn(),worlds:[],changes:['Three shots'],hasDraft:true,onGenerate:vi.fn(),onKeep:vi.fn()});
  it('offers subject focus, regenerate, keep and return without defaulting to material randomization',()=>{
    const html=renderToStaticMarkup(<ExportSetupPanel {...props()}/>);
    expect(html).toContain('Whole product body');expect(html).toContain('aria-label="Film focus"');
    expect(html).toContain('Regenerate film');expect(html).toContain('Keep film');expect(html).toContain('Return to original film');
    expect(html).not.toContain('value="everything"');
  });
  it('prevents applying a draft after focus changes until it has been regenerated',()=>{
    const html=renderToStaticMarkup(<ExportSetupPanel {...props()} dirty/>);
    expect(html).toContain('disabled="">Keep film');expect(html).toContain('Focus changed');
  });
});
