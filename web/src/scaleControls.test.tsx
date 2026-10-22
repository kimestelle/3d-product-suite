import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import fixture from '../../examples/bottle.scene.json';
import FilmPoseInspector from './FilmPoseInspector';
import KeyframeEditor from './KeyframeEditor';

const noop=()=>{};
describe('small whole-product scale controls',()=>{
  it.each([1e-6,.32/216])('shows %s in the pose and keyframe editors without rounding to zero',scale=>{
    const scene:any=structuredClone(fixture);scene.placement.scale=scale;
    const value=String(Number((scale*100).toFixed(8)));
    const pose=renderToStaticMarkup(<FilmPoseInspector scene={scene} frame={1} target="$product" onChange={noop} onMotionSelect={noop}/>);
    const keys=renderToStaticMarkup(<KeyframeEditor scene={scene} componentId={null} frame={1} onFrame={noop} onChange={noop} playing={false} onPlay={noop} scope="world"/>);
    for(const html of [pose,keys]){
      expect(html).toContain(`value="${value}"`);
      expect(html).toContain('min="0.0001" max="100000000"');
      expect(html).not.toContain('aria-invalid="true"');
    }
  });
  it('retains the part scale range',()=>{
    const html=renderToStaticMarkup(<FilmPoseInspector scene={fixture} frame={1} target="cap" onChange={noop} onMotionSelect={noop}/>);
    expect(html).toContain('min="1" max="10000"');
  });
});
