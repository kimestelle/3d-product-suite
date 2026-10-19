import {describe,expect,it} from 'vitest';
import {contourSpan,philosophyContour,philosophyGeometry,type PhilosophyPoint} from './philosophyFlow';

const bounds=(points:PhilosophyPoint[])=>({left:Math.min(...points.map(p=>p.x)),right:Math.max(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),bottom:Math.max(...points.map(p=>p.y))});
const near=(actual:PhilosophyPoint,expected:PhilosophyPoint)=>{expect(actual.x).toBeCloseTo(expected.x,6);expect(actual.y).toBeCloseTo(expected.y,6);};

describe('Philosophy specimen projection',()=>{
  it('shares the smaller initial specimen and padded final circle with rendering',()=>{
    const ground=philosophyGeometry(1280,832,0),circle=philosophyGeometry(1280,832,1);
    expect(ground.width).toBeCloseTo(655.119872*.96,6);expect(ground.height).toBeCloseTo(354.7158272*.96,6);
    expect(ground.radius).toBe(38.4);expect(ground.rotation).toBe(-30);
    expect(circle.width).toBe(696);expect(circle.height).toBe(696);expect(circle.radius).toBe(348);expect(circle.rotation).toBeCloseTo(0,6);
    for(const progress of [0,.1,.5,.9,1]) {
      const geometry=philosophyGeometry(1280,832,progress);
      expect(geometry.radius).toBeLessThanOrEqual(Math.min(geometry.width,geometry.height)/2);
    }
  });
  it('reproduces the initial rotated rounded rectangle rather than its bounding box',()=>{
    const points=philosophyContour(1280,832,0);
    const cx=1280*(.53387045+.02)+51.2,cy=416-1280*.0012644;
    const width=1280*.5118124*.96,height=1280*.27712174*.96,radius=38.4;
    expect(cx).toBeCloseTo(760.154176,6);
    expect(cy).toBeCloseTo(414.381568,6);
    const c=Math.cos(Math.PI/6),s=Math.sin(Math.PI/6);
    for(const p of points) {
      // Undo the -30-degree rotation and check the actual rounded perimeter.
      const x=(p.x-cx)*c-(p.y-cy)*s,y=(p.x-cx)*s+(p.y-cy)*c;
      const dx=Math.max(0,Math.abs(x)-(width/2-radius));
      const dy=Math.max(0,Math.abs(y)-(height/2-radius));
      expect(Math.hypot(dx,dy)).toBeCloseTo(radius,6);
    }
    const box=bounds(points);
    const ex=(width/2-radius)*c+(height/2-radius)*s+radius;
    const ey=(width/2-radius)*s+(height/2-radius)*c+radius;
    expect(box.left).toBeCloseTo(cx-ex,6);expect(box.right).toBeCloseTo(cx+ex,6);
    expect(box.top).toBeCloseTo(cy-ey,6);expect(box.bottom).toBeCloseTo(cy+ey,6);
  });
  it('fits the final circle inside the fixed header and outer padding',()=>{
    const points=philosophyContour(1280,832,1),cx=388,cy=444;
    for(const point of points)expect(Math.hypot(point.x-cx,point.y-cy)).toBeCloseTo(348,6);
    const box=bounds(points);
    expect(box.left).toBeCloseTo(40,6);expect(box.right).toBeCloseTo(736,6);
    expect(box.top).toBeCloseTo(96,6);expect(box.bottom).toBeCloseTo(792,6);
  });
  it.each([0,.17,.4,.65,.93,1])('preserves center symmetry and proportions when fitted at %s',progress=>{
    const points=philosophyContour(1280,832,progress);
    const geometry=philosophyGeometry(1280,832,progress);
    expect(points).toHaveLength(100);
    expect(geometry.width/geometry.height).toBeCloseTo(
      (.5118124+.1131876*progress)/(.27712174+.34787826*progress),10);
    for(let i=0;i<points.length;i++) {
      const opposite=points[(i+points.length/2)%points.length];
      near({x:points[i].x+opposite.x,y:points[i].y+opposite.y},
        {x:geometry.x*2,y:geometry.y*2});
    }
  });
  it('keeps the full rotated perimeter inside the safe box at every desktop size and scroll step',()=>{
    for(const width of [800,955,1280,1600])for(const height of [600,832,1100])
      for(let step=0;step<=40;step++) {
        const geometry=philosophyGeometry(width,height,step/40);
        const angle=geometry.rotation*Math.PI/180;
        const cos=Math.abs(Math.cos(angle)),sin=Math.abs(Math.sin(angle));
        const ex=(geometry.width/2-geometry.radius)*cos+(geometry.height/2-geometry.radius)*sin+geometry.radius;
        const ey=(geometry.width/2-geometry.radius)*sin+(geometry.height/2-geometry.radius)*cos+geometry.radius;
        // Check the true curve's support too, not only its sampled vertices.
        expect(geometry.x-ex).toBeGreaterThanOrEqual(40-1e-8);
        expect(geometry.x+ex).toBeLessThanOrEqual(width-40+1e-8);
        expect(geometry.y-ey).toBeGreaterThanOrEqual(96-1e-8);
        expect(geometry.y+ey).toBeLessThanOrEqual(height-40+1e-8);
        for(const point of philosophyContour(width,height,step/40)) {
          expect(point.x).toBeGreaterThanOrEqual(40-1e-8);
          expect(point.x).toBeLessThanOrEqual(width-40+1e-8);
          expect(point.y).toBeGreaterThanOrEqual(96-1e-8);
          expect(point.y).toBeLessThanOrEqual(height-40+1e-8);
        }
      }
  });
  it('reserves the readable right lane after the opening transition',()=>{
    for(const width of [800,955,1280,1600])for(const height of [600,832,1100])
      for(const progress of [.35,.5,.75,1]) {
        const box=bounds(philosophyContour(width,height,progress));
        const lane=Math.min(480,Math.max(280,width*.36));
        expect(box.right).toBeLessThanOrEqual(width-40-lane-24+1e-8);
      }
    expect(philosophyGeometry(955,832,1).width).toBeCloseTo(507.2,6);
    expect(philosophyGeometry(800,832,1).width).toBeCloseTo(408,6);
  });
  it('fits a circle without reducing it for nonexistent rectangular corners',()=>{
    const circle=philosophyGeometry(1600,1100,1);
    expect(circle.width).toBe(964);expect(circle.height).toBe(964);
    expect(circle.radius).toBe(482);
  });
  it('is deterministic in either scroll direction, with no previous-frame state',()=>{
    const forward=[0,.1,.25,.5,.75,.9,1].map(progress=>philosophyContour(1280,832,progress));
    const backward=[1,.9,.75,.5,.25,.1,0].map(progress=>philosophyContour(1280,832,progress)).reverse();
    expect(backward).toEqual(forward);
  });
  it('clamps progress and keeps degenerate or invalid viewport measurements finite',()=>{
    expect(philosophyContour(1280,832,-1)).toEqual(philosophyContour(1280,832,0));
    expect(philosophyContour(1280,832,2)).toEqual(philosophyContour(1280,832,1));
    expect(philosophyContour(1280,832,NaN)).toEqual(philosophyContour(1280,832,0));
    expect(philosophyContour(1280,832,Infinity)).toEqual(philosophyContour(1280,832,1));
    expect(philosophyContour(1280,832,-Infinity)).toEqual(philosophyContour(1280,832,0));
    for(const [w,h] of [[0,0],[-100,832],[NaN,Infinity],[1280,-50]])
      for(const p of philosophyContour(w,h,.75))expect(Number.isFinite(p.x)&&Number.isFinite(p.y)).toBe(true);
  });
});

describe('Text clearance through a vertical band',()=>{
  const diamond=[{x:0,y:50},{x:50,y:0},{x:100,y:50},{x:50,y:100}];
  it('includes edge intersections when no vertices lie inside the band',()=>{
    expect(contourSpan(diamond,20,30)).toEqual({left:20,right:80});
    expect(contourSpan(diamond,30,20)).toEqual({left:20,right:80});
  });
  it('uses interior vertices as well as the band boundaries',()=>{
    expect(contourSpan(diamond,40,60)).toEqual({left:0,right:100});
  });
  it('returns the complete extent when the band contains the whole polygon',()=>{
    expect(contourSpan(diamond,-20,120)).toEqual({left:0,right:100});
  });
  it('returns no obstruction above or below the contour',()=>{
    expect(contourSpan(diamond,-20,-1)).toBeNull();
    expect(contourSpan(diamond,101,120)).toBeNull();
  });
  it('handles exact tangencies, zero-height bands, and horizontal edges',()=>{
    expect(contourSpan(diamond,0,0)).toEqual({left:50,right:50});
    expect(contourSpan(diamond,50,50)).toEqual({left:0,right:100});
    expect(contourSpan([{x:2,y:3},{x:8,y:3},{x:8,y:9},{x:2,y:9}],3,3)).toEqual({left:2,right:8});
  });
  it('follows circle curvature instead of reserving its full bounding box',()=>{
    const points=philosophyContour(1280,832,1),cx=388,cy=444,radius=348;
    const center=contourSpan(points,cy,cy)!;
    expect(center.left).toBeCloseTo(cx-radius,6);expect(center.right).toBeCloseTo(cx+radius,6);
    const upper=contourSpan(points,cy-radius+24,cy-radius+44)!;
    const expectedRadius=Math.sqrt(radius**2-(radius-44)**2);
    // The polygon is sampled on the true curve; its chord error stays below a pixel.
    expect(Math.abs(upper.right-(cx+expectedRadius))).toBeLessThan(1);
    expect(Math.abs(upper.left-(cx-expectedRadius))).toBeLessThan(1);
    expect(upper.right-upper.left).toBeLessThan(center.right-center.left);
  });
  it('rejects invalid bands or coordinates without leaking NaN into layout',()=>{
    expect(contourSpan([],0,20)).toBeNull();
    expect(contourSpan(diamond,NaN,20)).toBeNull();
    expect(contourSpan(diamond,0,Infinity)).toBeNull();
    expect(contourSpan([{x:NaN,y:0}],0,20)).toBeNull();
  });
});
