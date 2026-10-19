import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {clearCache,prepareWithSegments} from '@chenglou/pretext';
import {frameBounds,philosophyFrameNodes} from './frameGeometry';
import {createPhilosophySequence,philosophySequenceContour,philosophySequenceNodes} from './philosophySequence';
import {createContourQuery} from './philosophyContour';
import {layoutContourText,type LineFlowLeaf} from './philosophyLineLayout';

describe('Shape + Light editorial sequence',()=>{
  it('preserves compact covers and keeps the snapped desktop cover clear of its title',()=>{
    for(const [w,h] of [[390,844],[800,600],[900,700]])
      expect(philosophySequenceNodes(w,h,0)).toEqual(philosophyFrameNodes(w,h,0));
    for(const [w,h] of [[955,832],[1280,832],[1440,540],[1600,1100]]){
      const before=frameBounds(philosophyFrameNodes(w,h,0));
      const after=frameBounds(philosophySequenceNodes(w,h,0));
      expect(after.left).toBeGreaterThanOrEqual(before.left-1e-7);
      expect(after.width/after.height).toBeCloseTo(before.width/before.height,10);
    }
  });

  it('aligns every desktop endpoint’s true bounds with the seven-column layout grid',()=>{
    for(const [w,h] of [[901,700],[955,832],[1000,600],[1201,700],[1280,832],[1440,540],[1600,1100],[1920,1080]]){
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

  it('keeps true cubic bounds inside the fixed padding, including in-between frames',()=>{
    for(const [w,h] of [[800,600],[955,832],[1280,832],[1440,540],[1600,1100]])
      for(let sample=0;sample<=100;sample++) {
        const nodes=philosophySequenceNodes(w,h,sample/20),bounds=frameBounds(nodes);
        expect(nodes).toHaveLength(64);
        // The preserved cover's circular cubics differ from ideal arcs by
        // millionths of a pixel; keep this far below a rendered pixel.
        expect(bounds.left).toBeGreaterThanOrEqual(40-1e-4);
        expect(bounds.top).toBeGreaterThanOrEqual(96-1e-4);
        expect(bounds.right).toBeLessThanOrEqual(w-40+1e-4);
        expect(bounds.bottom).toBeLessThanOrEqual(h-40+1e-4);
      }
  });

  it('reaches into the reading columns while retaining a readable lane at each endpoint',()=>{
    for(const [w,h] of [[955,832],[1280,832],[1440,540],[1600,1100]])
      for(let stage=1;stage<=5;stage++) {
        const bounds=frameBounds(philosophySequenceNodes(w,h,stage));
        const pitch=(w-60)/7,copyWidth=3*pitch-20;
        const readingWidth=Math.min(240,(w-80)*.24),gap=24;
        if(stage%2===1) {
          const copyLeft=40+pitch;
          expect(bounds.left-copyLeft-gap).toBeGreaterThanOrEqual(readingWidth-1e-7);
          expect(bounds.left-gap).toBeLessThan(copyLeft+copyWidth-24);
        } else {
          const copyLeft=40+4*pitch;
          expect(w-40-bounds.right-gap).toBeGreaterThanOrEqual(readingWidth-1e-7);
          expect(bounds.right+gap).toBeGreaterThan(copyLeft+24);
        }
      }
  });

  it('gives the sections distinct circle, rounded square, arch, wide window, and pill shapes',()=>{
    const shapes=Array.from({length:5},(_,index)=>philosophySequenceNodes(1280,832,index+1));
    const bounds=shapes.map(frameBounds);
    expect(bounds[0].width).toBeCloseTo(bounds[0].height,8);
    expect(bounds[1].width).toBeCloseTo(bounds[1].height,8);
    expect(bounds[1].width).toBeGreaterThan(bounds[0].width);
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

/** Deterministic font metrics keep this an integration test of the actual
 * contour and Pretext line-breaking path, independent of installed fonts. */
class TestCanvas {
  getContext() {
    return {font:'16px sans-serif',letterSpacing:'0px',measureText(text:string) {
      const size=Number(this.font.match(/([\d.]+)px/)?.[1]??16);
      const width=[...text].length*size/2;
      return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width};
    }};
  }
}

describe('editorial shapes and selectable contour text',()=>{
  beforeAll(()=>{vi.stubGlobal('OffscreenCanvas',TestCanvas);clearCache();});
  afterAll(()=>{clearCache();vi.unstubAllGlobals();});

  it('changes real line breaks or positions without losing words or crossing the contour',()=>{
    const text='From any step, jump to a polished still or film. Gesso fills the gaps around the decisions you have made. Everything it adds stays inspectable and editable.';
    for(const [w,h] of [[955,832],[1280,832],[1440,540],[1600,1100]])
      for(let stage=1;stage<=5;stage++) {
        const nodes=philosophySequenceNodes(w,h,stage),bounds=frameBounds(nodes);
        const query=createContourQuery(philosophySequenceContour(nodes));
        const pitch=(w-60)/7,side=stage%2===1?'left':'right';
        const left=40+(side==='left'?1:4)*pitch,top=bounds.top+bounds.height*.35;
        const leaf:LineFlowLeaf={prepared:prepareWithSegments(text,'400 16px "Halyard Text"'),
          lineHeight:24,top:0,left:0,width:3*pitch-20,naturalHeight:96};
        const options={left,top,right:w-40,side,query} as const;
        const plain=layoutContourText([leaf],{...options,query:()=>null});
        const flow=layoutContourText([leaf],options);
        expect(flow.lines.map(line=>[line.left,line.text]),`no reflow at ${w}×${h}, section ${stage}`)
          .not.toEqual(plain.lines.map(line=>[line.left,line.text]));
        expect(flow.lines.map(line=>line.text+line.separator).join('')).toBe(text);
        expect(top+flow.height).toBeLessThanOrEqual(h-40);
        for(const line of flow.lines) {
          const lineLeft=left+line.left,lineRight=lineLeft+line.width;
          expect(lineLeft).toBeGreaterThanOrEqual(40);
          expect(lineRight).toBeLessThanOrEqual(w-40);
          const edge=query(top+line.top-4,top+line.top+leaf.lineHeight+4);
          if(edge) {
            if(side==='left')expect(lineRight).toBeLessThanOrEqual(edge.left-24+1e-7);
            else expect(lineLeft).toBeGreaterThanOrEqual(edge.right+24-1e-7);
          }
        }
      }
  });
});
