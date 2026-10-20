import {describe,expect,it} from 'vitest';
import {frameBounds,type FrameBounds} from './frameGeometry';
import {frameHaloRegion} from './frameHalo';
import {createPhilosophySequence} from './philosophySequence';
import {studioLoadingNodes,STUDIO_LOADING_CYCLE_MS} from './studioLoading';

function expectBlurClearance(bounds:FrameBounds,blur:number,spread:number) {
  const region=frameHaloRegion(bounds,blur,spread),clearance=spread+4*blur;
  expect(bounds.left-region.x).toBeGreaterThanOrEqual(clearance);
  expect(bounds.top-region.y).toBeGreaterThanOrEqual(clearance);
  expect(region.x+region.width-bounds.right).toBeGreaterThanOrEqual(clearance);
  expect(region.y+region.height-bounds.bottom).toBeGreaterThanOrEqual(clearance);
  return region;
}

describe('Contour-local halo filter region',()=>{
  it('keeps blur clearance throughout the foreshortened loader cycle without a viewport-sized surface',()=>{
    for(let step=0;step<=80;step++) {
      const bounds=frameBounds(studioLoadingNodes(STUDIO_LOADING_CYCLE_MS*step/80,{x:640,y:416}));
      const region=expectBlurClearance(bounds,20,8);
      expect(region.width).toBeLessThanOrEqual(274);
      expect(region.height).toBeLessThanOrEqual(274);
    }
    const edgeOn=frameBounds(studioLoadingNodes(STUDIO_LOADING_CYCLE_MS/2,{x:640,y:416}));
    expect(edgeOn.height).toBeLessThan(17);
    expect(frameHaloRegion(edgeOn,20,8).height).toBe(198);
  });

  it.each([.3,.5])('keeps the broad Form + light halo clear at every midpoint with %s shrink',shrink=>{
    for(const [width,height] of [[955,832],[1280,832],[1440,540],[1600,1100]]) {
      const sample=createPhilosophySequence(width,height);
      const lightScale=Math.min(1.25,width/1280,height/832);
      for(const position of [.5,1.5,2.5,3.5,4.5]) {
        const bounds=frameBounds(sample(position,shrink));
        expectBlurClearance(bounds,136*lightScale,64*lightScale);
      }
    }
  });

  it('rounds every edge outward while retaining just the required pixel clearance',()=>{
    const bounds={left:-10.2,top:20.8,right:30.4,bottom:50.1,width:40.6,height:29.3};
    const region=frameHaloRegion(bounds,2.1,1.3);
    expect(region).toEqual({x:-22,y:9,width:65,height:53});
    expectBlurClearance(bounds,2.1,1.3);
  });

  it('keeps a finite nonempty region for a zero-size contour and zero blur',()=>{
    const bounds={left:17.25,top:-3.5,right:17.25,bottom:-3.5,width:0,height:0};
    expect(frameHaloRegion(bounds,0,0)).toEqual({x:15,y:-6,width:5,height:5});
  });

  it.each([-1,NaN,Infinity,-Infinity])('ignores invalid blur and spread values: %s',value=>{
    const bounds={left:0,top:0,right:10,bottom:10,width:10,height:10};
    expect(frameHaloRegion(bounds,value,3)).toEqual(frameHaloRegion(bounds,0,3));
    expect(frameHaloRegion(bounds,4,value)).toEqual(frameHaloRegion(bounds,4,0));
    expect(frameHaloRegion(bounds,value,value)).toEqual(frameHaloRegion(bounds,0,0));
  });
});
