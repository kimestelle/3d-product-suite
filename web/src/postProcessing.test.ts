import {describe,it,expect} from 'vitest';
import {analyzeDisplayPixels,DEFAULT_POST_PROCESSING,gradeDisplayRGB,postProcessingIsNeutral,resolvePostProcessing,suggestAutoBalance} from './postProcessing';
const pixels=(rgb:number[],count=32)=>new Uint8ClampedArray(Array.from({length:count},()=>[...rgb,255]).flat());
describe('display-referred grade recipe',()=>{
  it('preserves absent and disabled pixels, and treats enabled-neutral as a fast-path',()=>{
    const c:[number,number,number]=[.1,.25,.8];expect(gradeDisplayRGB(c)).toEqual(c);
    expect(gradeDisplayRGB(c,{enabled:false,exposureEV:3})).toEqual(c);
    expect(postProcessingIsNeutral({enabled:true})).toBe(true);expect(postProcessingIsNeutral({enabled:true,grain:.01})).toBe(false);
  });
  it('uses stops for exposure and bounds saturation around luminance',()=>{
    expect(gradeDisplayRGB([.1,.2,.3],{enabled:true,exposureEV:1})).toEqual([.2,.4,.6]);
    const gray=gradeDisplayRGB([.2,.4,.6],{enabled:true,saturation:0});expect(gray[0]).toBeCloseTo(.37192);expect(new Set(gray).size).toBe(1);
  });
  it('lifts shadows more than highlights and keeps output in the display range',()=>{
    const low=gradeDisplayRGB([.1,.1,.1],{enabled:true,shadows:1})[0]-.1;
    const high=gradeDisplayRGB([.9,.9,.9],{enabled:true,shadows:1})[0]-.9;
    expect(low).toBeGreaterThan(high*10);
    expect(gradeDisplayRGB([1,.5,.2],{enabled:true,exposureEV:3})).toEqual([1,1,1]);
  });
  it('normalizes stale/nonfinite scene values without inventing an enabled grade',()=>{
    expect(resolvePostProcessing({exposureEV:Infinity,contrast:-4,saturation:8,grain:NaN})).toEqual({...DEFAULT_POST_PROCESSING,contrast:.5,saturation:2});
    expect(DEFAULT_POST_PROCESSING.enabled).toBe(false);
  });
});
describe('single-frame auto balance',()=>{
  it('measures actual display pixels with alpha and clipping evidence',()=>{
    const p=pixels([64,128,192]);const result=analyzeDisplayPixels(p);
    expect(result.sampleCount).toBe(32);expect(result.meanRGB[1]).toBeCloseTo(128/255);expect(result.clippedFraction).toBe(0);
    const transparent=new Uint8ClampedArray([...p,...new Uint8ClampedArray(32*4)]);expect(analyzeDisplayPixels(transparent)).toEqual(result);
    expect(analyzeDisplayPixels(pixels([255,64,64])).clippedFraction).toBe(1);
    expect(()=>analyzeDisplayPixels(new Uint8ClampedArray(16))).toThrow('too few visible pixels');
  });
  it('keeps automatic changes bounded and does not overwrite manual look/effects',()=>{
    const source={saturation:.75,contrast:1.1,vignette:.2,grain:.03};const before=structuredClone(source);
    const grade=suggestAutoBalance(analyzeDisplayPixels(pixels([8,10,30])),source);
    expect(grade.enabled).toBe(true);expect(grade.exposureEV).toBeLessThanOrEqual(.75);expect(Math.abs(grade.temperature)).toBeLessThanOrEqual(.25);
    for(const key of ['saturation','contrast','vignette','grain'] as const)expect(grade[key]).toBe(source[key]);expect(source).toEqual(before);
  });
  it('does not brighten already clipped highlights and rejects malformed evidence',()=>{
    const bright=suggestAutoBalance(analyzeDisplayPixels(pixels([250,250,250])));
    expect(bright.exposureEV).toBeLessThanOrEqual(0);expect(bright.highlights).toBeLessThan(0);
    const measured=analyzeDisplayPixels(pixels([64,64,64]));expect(()=>suggestAutoBalance({...measured,sampleCount:0})).toThrow('could not be measured');
    expect(()=>suggestAutoBalance({...measured,p10Luma:.8,p90Luma:.2})).toThrow('could not be measured');
  });
});
