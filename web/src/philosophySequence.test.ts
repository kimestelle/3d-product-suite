import {describe,expect,it} from 'vitest';
import {frameBounds,philosophyFrameNodes} from './frameGeometry';
import {createPhilosophySequence,philosophyReadingBounds,philosophySequenceContour,philosophySequenceNodes} from './philosophySequence';

function scrollPositionForEasedProgress(progress:number) {
  let low=0,high=1;
  for(let step=0;step<48;step++) {
    const middle=(low+high)/2;
    if(middle*middle*(3-2*middle)<progress)low=middle;else high=middle;
  }
  return (low+high)/2;
}

describe('Form + Light editorial sequence',()=>{
  it('changes shrink on a held playhead without rebuilding or moving finished frames',()=>{
    const sample=createPhilosophySequence(1280,832),end=sample(2);
    for(const shrink of [0,.08,.25,.5]) {
      const plain=frameBounds(sample(1.5,0)),adjusted=frameBounds(sample(1.5,shrink));
      expect(adjusted.width).toBeCloseTo(plain.width*(1-shrink),7);
      expect(adjusted.left+adjusted.width/2).toBeCloseTo(plain.left+plain.width/2,7);
      expect(sample(2,shrink)).toBe(end);
      expect(sample(1.5,shrink)).toEqual(philosophySequenceNodes(1280,832,1.5,shrink));
    }
  });
  it('opens space at the midpoint while retaining each finished composition',()=>{
    const sample=createPhilosophySequence(1280,832);
    const a=frameBounds(sample(1)),b=frameBounds(sample(2)),middle=frameBounds(sample(1.5));
    expect(middle.width).toBeCloseTo((a.width+b.width)/2*.7,7);
    expect(middle.height).toBeCloseTo((a.height+b.height)/2*.7,7);
    expect(middle.left+middle.width/2).toBeCloseTo((a.left+a.width/2+b.left+b.width/2)/2,7);
    expect(middle.top+middle.height/2).toBeCloseTo((a.top+a.height/2+b.top+b.height/2)/2,7);
  });
  it('preserves compact covers and uniformly fits the desktop cover within the inner grid',()=>{
    for(const [w,h] of [[390,844],[800,600],[900,700]])
      expect(philosophySequenceNodes(w,h,0)).toEqual(philosophyFrameNodes(w,h,0));
    for(const [w,h] of [[955,832],[1280,832],[1440,540],[1600,1100]]){
      const before=frameBounds(philosophyFrameNodes(w,h,0));
      const after=frameBounds(philosophySequenceNodes(w,h,0));
      const pitch=(w-60)/7;
      expect(after.left).toBeGreaterThanOrEqual(40+3*pitch-1e-7);
      expect(after.right).toBeLessThanOrEqual(w-40-pitch+1e-7);
      expect(after.width/after.height).toBeCloseTo(before.width/before.height,10);
    }
  });

  it('reserves the outside columns symmetrically and leaves compact padding unchanged',()=>{
    for(const width of [901,955,1280,1422,1600,1920]) {
      const pitch=(width-60)/7,bounds=philosophyReadingBounds(width);
      expect(bounds.left).toBeCloseTo(40+pitch,10);
      expect(bounds.right).toBeCloseTo(40+6*pitch-20,10);
      expect(bounds.left).toBeCloseTo(width-bounds.right,10);
    }
    for(const width of [390,800,900]) {
      const bounds=philosophyReadingBounds(width);
      expect(bounds.left).toBe(40);
      expect(bounds.right).toBe(width-40);
    }
  });

  it('retains every endpoint and contracts all transition midpoints by thirty percent',()=>{
    for(const [w,h] of [[901,700],[955,832],[1280,832],[1422,900],[1600,1100],[1920,1080]]) {
      const sample=createPhilosophySequence(w,h);
      for(let stage=0;stage<=5;stage++) {
        const endpoint=sample(stage);
        expect(sample(stage,0)).toBe(endpoint);
        expect(sample(stage,.3)).toBe(endpoint);
        expect(endpoint).toHaveLength(64);
      }
      for(let stage=0;stage<5;stage++) {
        const plainNodes=sample(stage+.5,0),shrunkNodes=sample(stage+.5);
        const plain=frameBounds(plainNodes),shrunk=frameBounds(shrunkNodes);
        expect(shrunk.width).toBeCloseTo(plain.width*.7,7);
        expect(shrunk.height).toBeCloseTo(plain.height*.7,7);
        // Asymmetric corner radii can offset the AABB midpoint. Opposing
        // side anchors retain the actual authored transform center.
        for(const axis of ['x','y'] as const)
          expect((shrunkNodes[0].point[axis]+shrunkNodes[32].point[axis])/2)
            .toBeCloseTo((plainNodes[0].point[axis]+plainNodes[32].point[axis])/2,7);
      }
    }
  });

  it('keeps the window near its outgoing and incoming lanes outside the middle crossing',()=>{
    for(const [width,height] of [[955,832],[1280,832],[1422,900],[1920,1080]]) {
      const sample=createPhilosophySequence(width,height);
      const center=(position:number)=>{
        const nodes=sample(position);
        return (nodes[0].point.x+nodes[32].point.x)/2;
      };
      // The cover and introduction occupy the same side; the four following
      // transitions cross the reading lanes in alternating directions.
      for(let stage=1;stage<5;stage++) {
        const from=center(stage),to=center(stage+1),distance=Math.abs(to-from);
        expect(distance).toBeGreaterThan(0);
        for(const progress of [.05,.125,.25,.75,.875,.95]) {
          const x=center(stage+scrollPositionForEasedProgress(progress));
          const endpoint=progress<=.25?from:to;
          expect(Math.abs(x-endpoint),`${width}×${height}, section ${stage}, eased ${progress}`)
            .toBeLessThanOrEqual(distance*.05+1);
        }
      }
    }
  });

  it('starts and finishes horizontal crossing without a position or velocity jump',()=>{
    const sample=createPhilosophySequence(1280,832);
    const center=(progress:number)=>{
      const nodes=sample(1+scrollPositionForEasedProgress(progress));
      return (nodes[0].point.x+nodes[32].point.x)/2;
    };
    const from=center(0),to=center(1),travel=Math.abs(to-from),epsilon=1e-5;
    for(const boundary of [.25,.75]) {
      const before=center(boundary-epsilon),at=center(boundary),after=center(boundary+epsilon);
      expect(at).toBeCloseTo(boundary===.25?from:to,7);
      expect(Math.abs(after-before)/travel).toBeLessThan(1e-8);
      expect(Math.abs((after-at)/epsilon)/travel).toBeLessThan(.001);
      expect(Math.abs((at-before)/epsilon)/travel).toBeLessThan(.001);
    }
  });

  it('aligns every desktop endpoint’s true bounds with the seven-column layout grid',()=>{
    for(const [w,h] of [[901,700],[955,832],[1000,600],[1201,700],[1280,832],[1422,900],[1440,540],[1600,1100],[1920,1080]]){
      const pitch=(w-60)/7,column=pitch-20;
      const edges=Array.from({length:7},(_,i)=>[40+i*pitch,40+i*pitch+column]).flat();
      for(let stage=0;stage<=5;stage++){
        const bounds=frameBounds(philosophySequenceNodes(w,h,stage));
        for(const edge of [bounds.left,bounds.right])
          expect(Math.min(...edges.map(value=>Math.abs(value-edge))),`off-grid at ${w}×${h}, section ${stage}`).toBeLessThan(1e-7);
        expect(bounds.top/4).toBeCloseTo(Math.round(bounds.top/4),8);
      }
    }
  });

  it('keeps rotated midpoints rectangular with circular corners rather than skewing their handles',()=>{
    for(const [position,rotation] of [[.5,-15],[1.5,0],[2.5,0],[3.5,4],[4.5,-9.5]]) {
      const nodes=philosophySequenceNodes(1280,832,position);
      const center={x:(nodes[0].point.x+nodes[32].point.x)/2,y:(nodes[0].point.y+nodes[32].point.y)/2};
      const angle=-rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
      const local=nodes.map(({point:p})=>({x:(p.x-center.x)*cos-(p.y-center.y)*sin,y:(p.x-center.x)*sin+(p.y-center.y)*cos}));
      expect(local[0].y).toBeCloseTo(0,8);expect(local[32].y).toBeCloseTo(0,8);
      expect(local[16].x).toBeCloseTo(0,8);expect(local[48].x).toBeCloseTo(0,8);
      // Each corner keeps one center and radius while its pose changes.
      for(const start of [6,22,38,54]) {
        const a=local[start],b=local[start+4];
        const corner=start===6||start===38?{x:b.x,y:a.y}:{x:a.x,y:b.y};
        const radius=Math.hypot(a.x-corner.x,a.y-corner.y);
        for(let point=start;point<=start+4;point++)
          expect(Math.hypot(local[point].x-corner.x,local[point].y-corner.y)).toBeCloseTo(radius,8);
      }
      if(position===1.5) {
        const width=local[0].x-local[32].x,height=local[16].y-local[48].y;
        expect(width).toBeCloseTo(height,8);
        expect((local[0].x-local[10].x)/width).toBeCloseTo(.35,8);
      }
    }
  });

  it('joins all non-degenerate segments tangentially throughout each morph',()=>{
    const sample=createPhilosophySequence(1280,832);
    for(let step=1;step<100;step++) {
      for(const node of sample(step/20)) {
        const incoming={x:node.point.x-node.in.x,y:node.point.y-node.in.y};
        const outgoing={x:node.out.x-node.point.x,y:node.out.y-node.point.y};
        const length=Math.hypot(incoming.x,incoming.y)*Math.hypot(outgoing.x,outgoing.y);
        if(length<1e-8)continue;
        expect(Math.abs(incoming.x*outgoing.y-incoming.y*outgoing.x)/length).toBeLessThan(1e-8);
        expect((incoming.x*outgoing.x+incoming.y*outgoing.y)/length).toBeGreaterThan(1-1e-8);
      }
    }
  });

  it('does not fold or self-intersect between endpoints',()=>{
    type Point={x:number;y:number};
    const orientation=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    for(const [w,h] of [[800,600],[1280,832],[1440,540]]) {
      const sample=createPhilosophySequence(w,h);
      for(const position of [.1,.5,.9,1.25,1.5,2.25,2.5,2.75,3.25,3.5,3.75,4.25,4.5,4.75]) {
        const points=philosophySequenceContour(sample(position)).filter((_,index)=>index%2===0);
        let intersects=false;
        segments:for(let i=0;i<points.length;i++) {
          const a=points[i],b=points[(i+1)%points.length];
          for(let j=i+2;j<points.length;j++) {
            if(i===0&&j===points.length-1)continue;
            const c=points[j],d=points[(j+1)%points.length];
            const crosses=orientation(a,b,c)*orientation(a,b,d)<-1e-8&&orientation(c,d,a)*orientation(c,d,b)<-1e-8;
            if(crosses){intersects=true;break segments;}
          }
        }
        expect(intersects,`crossing at ${w}×${h}, section ${position}`).toBe(false);
      }
    }
  });

  it('reuses compiled endpoints and matches the authored contour through the entire sequence',()=>{
    for(const [w,h] of [[800,600],[1280,832],[1440,540]]) {
      const sample=createPhilosophySequence(w,h);
      for(const position of [-Infinity,NaN,...Array.from({length:51},(_,index)=>index/10),Infinity])
        expect(sample(position)).toEqual(philosophySequenceNodes(w,h,position));
      for(let stage=0;stage<=5;stage++)expect(sample(stage)).toBe(sample(stage));
    }
  });

  it('keeps independently sized samplers isolated when the viewport changes',()=>{
    const wide=createPhilosophySequence(1440,832),narrow=createPhilosophySequence(800,600);
    const original=wide(3);
    expect(narrow(3)).not.toEqual(original);
    expect(wide(3)).toBe(original);
    expect(wide(2.5)).toEqual(philosophySequenceNodes(1440,832,2.5));
  });

  it('keeps true cubic bounds inside the inner columns throughout each morph',()=>{
    for(const [w,h] of [[800,600],[901,700],[955,832],[1280,832],[1422,900],[1440,540],[1600,1100],[1920,1080]])
      for(let sample=0;sample<=100;sample++) {
        const nodes=philosophySequenceNodes(w,h,sample/20),bounds=frameBounds(nodes);
        const inset=w>900?(w-60)/7:0;
        expect(nodes).toHaveLength(64);
        // The preserved cover's circular cubics differ from ideal arcs by
        // millionths of a pixel; keep this far below a rendered pixel.
        expect(bounds.left).toBeGreaterThanOrEqual(40+inset-1e-4);
        expect(bounds.top).toBeGreaterThanOrEqual(96-1e-4);
        expect(bounds.right).toBeLessThanOrEqual(w-40-inset+1e-4);
        expect(bounds.bottom).toBeLessThanOrEqual(h-40+1e-4);
      }
  });

  it('leaves a fixed two-column text line and a twenty-four pixel gap at every endpoint',()=>{
    for(const [w,h] of [[901,700],[955,832],[1000,600],[1201,700],[1280,832],[1422,900],[1440,540],[1600,1100],[1920,1080]])
      for(let stage=0;stage<=5;stage++) {
        const bounds=frameBounds(philosophySequenceNodes(w,h,stage));
        const pitch=(w-60)/7,lineWidth=2*pitch-44,gap=24;
        const left=40+pitch,right=w-40-pitch;
        const context=`${w}×${h}, section ${stage}`;
        if(stage===0||stage%2===1) {
          expect(bounds.left-left-gap,context).toBeGreaterThanOrEqual(lineWidth-1e-7);
        } else {
          expect(right-bounds.right-gap,context).toBeGreaterThanOrEqual(lineWidth-1e-7);
        }
      }
  });

  it('gives the sections distinct circle, rounded square, arch, wide window, and pill shapes',()=>{
    const shapes=Array.from({length:5},(_,index)=>philosophySequenceNodes(1280,832,index+1));
    const bounds=shapes.map(frameBounds);
    expect(bounds[0].width).toBeCloseTo(bounds[0].height,8);
    expect(bounds[1].width).toBeCloseTo(bounds[1].height,8);
    expect(bounds[2].height/bounds[2].width).toBeGreaterThan(1.2);
    expect(bounds[3].width/bounds[3].height).toBeGreaterThan(1.3);
    // Circle anchors at 0/6 coincide; the square retains a straight side.
    expect(shapes[0][0].point).toEqual(shapes[0][6].point);
    expect(shapes[1][0].point.y).not.toEqual(shapes[1][6].point.y);
    // The pill is intentionally rotated, rather than an accidental skew.
    expect(shapes[4][0].point.y).toBeLessThan(shapes[4][32].point.y);
  });

  it('is deterministic in reverse and stationary through integer boundaries',()=>{
    const positions=Array.from({length:101},(_,index)=>index/20);
    const forward=positions.map(position=>philosophySequenceNodes(1280,832,position));
    const reverse=[...positions].reverse().map(position=>philosophySequenceNodes(1280,832,position)).reverse();
    expect(reverse).toEqual(forward);
    for(let stage=1;stage<5;stage++) {
      const exact=philosophySequenceNodes(1280,832,stage);
      for(const nearby of [stage-1e-5,stage+1e-5]) {
        const sample=philosophySequenceNodes(1280,832,nearby);
        sample.forEach((node,index)=>{
          expect(Math.hypot(node.point.x-exact[index].point.x,node.point.y-exact[index].point.y)).toBeLessThan(1e-5);
        });
      }
    }
  });

  it('samples the rendered nodes for text flow and accepts an empty contour',()=>{
    expect(philosophySequenceContour([])).toEqual([]);
    for(const position of [0,.37,1,1.7,2.5,3,4.8,5]) {
      const nodes=philosophySequenceNodes(1280,832,position),contour=philosophySequenceContour(nodes);
      expect(contour).toHaveLength(384);
      nodes.forEach((node,index)=>expect(contour[index*6]).toEqual(node.point));
      const bounds=frameBounds(nodes);
      contour.forEach(point=>{
        expect(point.x).toBeGreaterThanOrEqual(bounds.left-1e-7);
        expect(point.x).toBeLessThanOrEqual(bounds.right+1e-7);
        expect(point.y).toBeGreaterThanOrEqual(bounds.top-1e-7);
        expect(point.y).toBeLessThanOrEqual(bounds.bottom+1e-7);
      });
    }
  });

  it('clamps sequence position and keeps invalid or empty viewport sizes finite',()=>{
    for(const value of [-Infinity,-1,NaN])
      expect(philosophySequenceNodes(1280,832,value)).toEqual(philosophySequenceNodes(1280,832,0));
    for(const value of [6,Infinity])
      expect(philosophySequenceNodes(1280,832,value)).toEqual(philosophySequenceNodes(1280,832,5));
    for(const [w,h] of [[0,0],[-100,832],[NaN,Infinity],[1280,-50],[10,20]])
      for(const position of [0,.5,1,2.5,5])
        for(const node of philosophySequenceNodes(w,h,position))
          for(const point of [node.point,node.in,node.out])
            expect(Number.isFinite(point.x)&&Number.isFinite(point.y)).toBe(true);
  });
});
