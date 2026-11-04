import {describe,it,expect,vi} from 'vitest';
import {previewPostSamples} from './previewAntialias';

function renderer(color:number[],depth:number[],maxSamples=4){
  const gl={RENDERBUFFER:1,RGBA16F:2,DEPTH_COMPONENT24:3,SAMPLES:4,
    getInternalformatParameter:vi.fn((_target:number,format:number)=>new Int32Array(format===2?color:depth))};
  return {capabilities:{maxSamples},getContext:()=>gl} as any;
}
describe('bounded HDR preview antialiasing',()=>{
  it('requires two-sample support for both actual color and depth formats',()=>{
    expect(previewPostSamples(renderer([4,2,1],[4,2,1]))).toBe(2);
    expect(previewPostSamples(renderer([4,2],[4]))).toBe(0);
    expect(previewPostSamples(renderer([4],[4,2]))).toBe(0);
  });
  it('does not silently allocate four samples on devices without a two-sample mode',()=>{
    expect(previewPostSamples(renderer([4],[4],8))).toBe(0);
    expect(previewPostSamples(renderer([2],[2],1))).toBe(0);
  });
  it('keeps a no-MSAA fallback for unavailable format queries',()=>{
    const value=renderer([2],[2]);value.getContext().getInternalformatParameter.mockImplementation(()=>{throw new Error('context unavailable');});
    expect(previewPostSamples(value)).toBe(0);
    expect(previewPostSamples({capabilities:{maxSamples:0}} as any)).toBe(0);
  });
});
