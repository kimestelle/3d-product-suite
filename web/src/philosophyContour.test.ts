import {describe,expect,it} from 'vitest';
import {createContourQuery} from './philosophyContour';
import {contourSpan,type PhilosophyPoint} from './philosophyFlow';
import {philosophySequenceContour,philosophySequenceNodes} from './philosophySequence';

const diamond:PhilosophyPoint[]=[{x:50,y:0},{x:100,y:50},{x:50,y:100},{x:0,y:50}];

describe('prepared contour queries',()=>{
  it('includes exact edge crossings when a band contains no vertices',()=>{
    const query=createContourQuery(diamond);
    expect(query(20,30)).toEqual({left:20,right:80});
    expect(query(30,20)).toEqual({left:20,right:80});
    expect(query(40,60)).toEqual({left:0,right:100});
    expect(query(-20,120)).toEqual({left:0,right:100});
    expect(query(0,0)).toEqual({left:50,right:50});
    expect(query(50,50)).toEqual({left:0,right:100});
    expect(query(-20,-1)).toBeNull();
    expect(query(101,120)).toBeNull();
  });

  it('retains horizontal boundaries and degenerate contours',()=>{
    const rectangle=[{x:2,y:3},{x:8,y:3},{x:8,y:9},{x:2,y:9}];
    expect(createContourQuery(rectangle)(3,3)).toEqual({left:2,right:8});
    expect(createContourQuery(rectangle)(9,9)).toEqual({left:2,right:8});
    expect(createContourQuery([{x:2,y:3}])(3,3)).toEqual({left:2,right:2});
    expect(createContourQuery([{x:2,y:3}])(4,5)).toBeNull();
  });

  it('rejects invalid contours and nonfinite bands',()=>{
    expect(createContourQuery([])(0,20)).toBeNull();
    expect(createContourQuery([{x:0,y:0},{x:NaN,y:10}])(0,20)).toBeNull();
    expect(createContourQuery([{x:0,y:0},{x:10,y:Infinity}])(0,20)).toBeNull();
    const query=createContourQuery(diamond);
    expect(query(NaN,20)).toBeNull();
    expect(query(0,Infinity)).toBeNull();
    expect(query(-Infinity,20)).toBeNull();
  });

  it('matches the existing span calculation across the morph and text-sized bands',()=>{
    for(const [width,height]of [[1280,832],[1920,1080],[960,640]]) {
      for(const position of [0,.13,.5,1,1.7,2.25,3,3.6,4.5,5]) {
        const contour=philosophySequenceContour(philosophySequenceNodes(width,height,position));
        const query=createContourQuery(contour);
        for(let top=-24;top<height+24;top+=37.25) {
          for(const extent of [0,14,24.5,80,180]) {
            const expected=contourSpan(contour,top,top+extent);
            expect(query(top,top+extent)).toEqual(expected);
            expect(query(top+extent,top)).toEqual(expected);
          }
        }
      }
    }
  });
});
