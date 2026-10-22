import {describe,expect,it} from 'vitest';
import {frameBounds,loadingFrameNodes,roundedFrameNodes,type FrameNodes} from './frameGeometry';
import {createStudioExpansion,studioLoadingNodes,STUDIO_LOADING_CYCLE_MS,STUDIO_LOADING_KEYFRAMES} from './studioLoading';

const keys=['point','in','out'] as const;
const center={x:640,y:416};
const distance=(a:FrameNodes,b:FrameNodes)=>Math.max(...a.flatMap((node,index)=>keys.map(key=>
  Math.hypot(node[key].x-b[index][key].x,node[key].y-b[index][key].y))));
function samples(nodes:FrameNodes) {
  return nodes.flatMap((node,index)=>Array.from({length:8},(_,sample)=>{
    const next=nodes[(index+1)%nodes.length],t=sample/8,u=1-t;
    return {x:u**3*node.point.x+3*u*u*t*node.out.x+3*u*t*t*next.in.x+t**3*next.point.x,
      y:u**3*node.point.y+3*u*u*t*node.out.y+3*u*t*t*next.in.y+t**3*next.point.y};
  }));
}
function expectConvex(nodes:FrameNodes) {
  const points=samples(nodes);
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],c=points[(i+2)%points.length];
    // Ripples in an expanding edge introduce local concavity even when all
    // anchors and shared tangents are finite. Sample between the anchors too.
    expect((b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x)).toBeGreaterThanOrEqual(-1e-6);
  }
}
function expectEllipse(nodes:FrameNodes) {
  const x=(nodes[0].point.x+nodes[32].point.x)/2,y=(nodes[0].point.y+nodes[32].point.y)/2;
  const a=nodes[0].point,b=nodes[16].point,rx=Math.hypot(a.x-x,a.y-y),ry=Math.hypot(b.x-x,b.y-y);
  const cos=(a.x-x)/rx,sin=(a.y-y)/rx;
  for(const p of samples(nodes)){
    const px=(p.x-x)*cos+(p.y-y)*sin,py=-(p.x-x)*sin+(p.y-y)*cos;
    expect((px/rx)**2+(py/ry)**2).toBeCloseTo(1,7);
  }
}

describe('Circle viewed from changing perspectives',()=>{
  it('keeps native transform interpolation within .03px of the shared ellipse',()=>{
    const scales=STUDIO_LOADING_KEYFRAMES.map(frame=>Number(String(frame.transform).match(/scaleY\(([^)]+)/)![1]));
    for(let i=0;i<scales.length-1;i++)for(const t of [.25,.5,.75]){
      const phase=(i+t)/(scales.length-1),interpolated=scales[i]+(scales[i+1]-scales[i])*t;
      const exact=1-.82*Math.sin(Math.PI*phase)**2;
      expect(Math.abs(interpolated-exact)*46).toBeLessThan(.03);
    }
    expect(scales[0]).toBe(1);expect(scales.at(-1)).toBe(1);
  });
  it('starts from the exact existing loading circle and loops without a seam',()=>{
    expect(studioLoadingNodes(0,center)).toEqual(loadingFrameNodes(center));
    expect(studioLoadingNodes(STUDIO_LOADING_CYCLE_MS,center)).toEqual(studioLoadingNodes(0,center));
    expect(distance(studioLoadingNodes(STUDIO_LOADING_CYCLE_MS-1,center),studioLoadingNodes(1,center))).toBeLessThan(.11);
    for(const elapsed of [0,700,1400,2800,4200])
      expect(distance(studioLoadingNodes(elapsed,center),studioLoadingNodes(elapsed+STUDIO_LOADING_CYCLE_MS,center))).toBeLessThan(1e-8);
  });
  it.each([{x:0,y:0},center,{x:188,y:361}])('keeps a true ellipse centered and bounded at %j',position=>{
    for(let step=0;step<=40;step++){
      const nodes=studioLoadingNodes(STUDIO_LOADING_CYCLE_MS*step/40,position),bounds=frameBounds(nodes);
      expect(nodes).toHaveLength(64);expectEllipse(nodes);
      expect((bounds.left+bounds.right)/2).toBeCloseTo(position.x,7);
      expect((bounds.top+bounds.bottom)/2).toBeCloseTo(position.y,7);
      expect(bounds.width).toBeLessThanOrEqual(92.00001);expect(bounds.height).toBeLessThanOrEqual(92.00001);
      expect(Math.min(bounds.width,bounds.height)).toBeGreaterThan(16);
    }
  });
  it('shows both horizontal and vertical perspectives, with no edge-on collapse',()=>{
    const vertical=frameBounds(studioLoadingNodes(STUDIO_LOADING_CYCLE_MS/4,center));
    const horizontal=frameBounds(studioLoadingNodes(STUDIO_LOADING_CYCLE_MS/2,center));
    expect(vertical.height/vertical.width).toBeGreaterThan(1.65);
    expect(horizontal.width/horizontal.height).toBeGreaterThan(5);
    expect(horizontal.height).toBeLessThan(18);
  });
});

describe('Loading disk opens into the actual editor window',()=>{
  const target=roundedFrameNodes({left:320,top:116,right:1240,bottom:800},
    {topLeft:28,topRight:40,bottomRight:24,bottomLeft:50});
  it('returns to a front-facing disk before growing, with no ripples at any loading phase',()=>{
    for(let phase=0;phase<24;phase++){
      const from=studioLoadingNodes(STUDIO_LOADING_CYCLE_MS*phase/24,center),original=structuredClone(from);
      const morph=createStudioExpansion(from,target);
      expect(morph(0)).toEqual(from);expect(morph(1)).toEqual(target);
      for(const t of [.001,.08,.2,.239,.24,.241,.3,.5,.75,.95,.999]){
        const nodes=morph(t);expect(nodes).toHaveLength(64);expectConvex(nodes);
        if(phase!==0&&t<.24){expectEllipse(nodes);expect(frameBounds(nodes).width).toBeLessThanOrEqual(92.00001);}
      }
      if(phase!==0){expect(distance(morph(.24),loadingFrameNodes(center))).toBeLessThan(1e-7);}
      expect(from).toEqual(original);
    }
  });
  it('retargets from the displayed oval or expanded window without a jump',()=>{
    const morph=createStudioExpansion(studioLoadingNodes(1400,center),target);
    const resized=roundedFrameNodes({left:320,top:116,right:1560,bottom:960},32);
    for(const t of [.1,.3,.6,.9]){
      const displayed=morph(t),next=createStudioExpansion(displayed,resized);
      expect(next(0)).toEqual(displayed);expect(next(1)).toEqual(resized);
      for(const p of [.1,.3,.7,.9])expectConvex(next(p));
    }
  });
});
