import {
  frameBounds, philosophyFrameNodes, roundedFrameNodes,
  transformFrameNodes, type FrameNodes, type FrameRadii,
} from './frameGeometry';
import type {ApertureNode} from './landingMorph';
import {philosophyGeometry,type PhilosophyPoint} from './philosophyFlow';
import {DEFAULT_FRAME_SHRINK,frameTransitionScale} from './frameMorph';

const dimension = (value:number) => Number.isFinite(value) ? Math.max(0,value) : 0;
const positionInSequence = (value:number) => Number.isNaN(value) ? 0 : Math.max(0,Math.min(5,value));
const smoothstep = (value:number) => value*value*(3-2*value);

type WindowSpec = {
  side:'left'|'right'; width:number; height:number;
  radii:number|Partial<FrameRadii>; rotation:number; vertical:number;
};

/** Authored shapes keep their proportions and reading lanes. Desktop endpoint
 * bounds snap to the same seven-column grid as the surrounding copy.
 */
type WindowGeometry={x:number;y:number;width:number;height:number;rotation:number;radii:FrameRadii};
type SequenceEndpoint={nodes:FrameNodes;geometry:WindowGeometry};
const CORNERS=['topLeft','topRight','bottomRight','bottomLeft'] as const;
const cornerRadii=(width:number,height:number,radii:WindowSpec['radii']):FrameRadii=>{
  const cap=Math.min(width,height)/2;
  return Object.fromEntries(CORNERS.map(key=>[key,Math.max(0,Math.min(cap,
    typeof radii==='number'?radii:radii[key]??0))])) as FrameRadii;
};

type GridLane={left:number;right:number};

/** Leave columns one and seven empty in the scrolling compositions. */
export function philosophyReadingBounds(width:number){
  const w=dimension(width),pitch=(w-60)/7;
  return w>900?{left:40+pitch,right:w-40-pitch,pitch}:{left:Math.min(40,w/2),right:Math.max(Math.min(40,w/2),w-40),pitch};
}

/** The guide uses true cubic extrema, so fit those same extrema to column
 * starts/ends. One uniform transform preserves pose, corners and all 64 anchors.
 * This runs only while compiling endpoints; the morph loop stays unchanged. */
function snapEndpoint(endpoint:SequenceEndpoint,w:number,h:number,lane:GridLane):SequenceEndpoint {
  if(w<=900||h<=136)return endpoint;
  const bounds=frameBounds(endpoint.nodes);
  if(bounds.width<=0||bounds.height<=0)return endpoint;
  const pitch=(w-60)/7,column=pitch-20;
  const edges=Array.from({length:7},(_,i)=>[40+i*pitch,40+i*pitch+column]).flat();
  const centerX=(bounds.left+bounds.right)/2,centerY=(bounds.top+bounds.bottom)/2;
  let best:{left:number;top:number;scale:number;score:number}|null=null;
  for(const left of edges)for(const right of edges){
    if(right<=left||left<lane.left-1e-7||right>lane.right+1e-7)continue;
    const scale=(right-left)/bounds.width,newHeight=bounds.height*scale;
    const lastTop=Math.floor((h-40-newHeight)/4)*4;
    if(lastTop<96)continue;
    const top=Math.max(96,Math.min(lastTop,Math.round((centerY-newHeight/2)/4)*4));
    const sizeError=scale-1,moveX=((left+right)/2-centerX)/bounds.width;
    const moveY=(top+newHeight/2-centerY)/bounds.height;
    const score=4*sizeError*sizeError+moveX*moveX+.25*moveY*moveY;
    if(!best||score<best.score)best={left,top,scale,score};
  }
  if(!best)return endpoint;
  const {scale}=best,translateX=best.left-bounds.left*scale,translateY=best.top-bounds.top*scale;
  const g=endpoint.geometry;
  return {
    nodes:transformFrameNodes(endpoint.nodes,{scaleX:scale,scaleY:scale,translateX,translateY}),
    geometry:{...g,x:g.x*scale+translateX,y:g.y*scale+translateY,
      width:g.width*scale,height:g.height*scale,
      radii:Object.fromEntries(CORNERS.map(key=>[key,g.radii[key]*scale])) as FrameRadii},
  };
}

function sequenceEndpoint(width:number,height:number,index:number):SequenceEndpoint {
  if(index===0) {
    const g=philosophyGeometry(width,height,0);
    const endpoint={nodes:philosophyFrameNodes(width,height,0),geometry:{...g,radii:cornerRadii(g.width,g.height,g.radius)}};
    if(width<=900)return endpoint;
    const {left,right,pitch}=philosophyReadingBounds(width);
    // The definition keeps two inner columns. Its tilted window fits the
    // remaining three, rather than borrowing the empty outside column.
    return snapEndpoint(endpoint,dimension(width),dimension(height),{left:left+2*pitch,right});
  }
  const w=dimension(width),h=dimension(height);
  const {left,right,pitch:columnPitch}=philosophyReadingBounds(w);
  const top=Math.min(96,h),bottom=Math.max(top,h-40);
  const innerWidth=right-left,innerHeight=bottom-top;
  const readingWidth=Math.min(240,innerWidth*.24);
  const gap=Math.min(24,innerWidth*.1);
  const circle=Math.min(w*.31,h*.56);
  const square=Math.min(w*.36,h*.64);
  const archWidth=w*.34,archHeight=h*.70;
  const wideWidth=w*.43,wideHeight=h*.42;
  const pillWidth=w*.44,pillHeight=h*.25;
  const specs:WindowSpec[]=[
    {side:'right',width:circle,height:circle,radii:circle/2,rotation:0,vertical:.46},
    {side:'left',width:square,height:square,radii:square*.20,rotation:0,vertical:.56},
    {side:'right',width:archWidth,height:archHeight,
      radii:{topLeft:archWidth/2,topRight:archWidth/2,bottomLeft:24,bottomRight:24},
      rotation:0,vertical:.46},
    {side:'left',width:wideWidth,height:wideHeight,
      radii:{topLeft:wideHeight*.44,topRight:wideHeight*.12,
        bottomRight:wideHeight*.44,bottomLeft:wideHeight*.12},
      rotation:8,vertical:.43},
    {side:'right',width:pillWidth,height:pillHeight,radii:pillHeight/2,
      rotation:-27,vertical:.57},
  ];
  const spec=specs[index-1];
  const reserve=w>900?2*columnPitch:readingWidth+gap;
  const laneLeft=spec.side==='right'?Math.min(right,left+reserve):left;
  const laneRight=spec.side==='left'?Math.max(left,right-reserve):right;
  const laneWidth=Math.max(0,laneRight-laneLeft);
  const local=transformFrameNodes(roundedFrameNodes({left:-spec.width/2,top:-spec.height/2,
    right:spec.width/2,bottom:spec.height/2},spec.radii),{rotation:spec.rotation});
  const bounds=frameBounds(local);
  // Fit the actual cubic outline, including rotated extrema; fitting anchors
  // alone can let the curve itself cross the fixed outer padding.
  const scale=Math.min(1,bounds.width>0?laneWidth/bounds.width:1,
    bounds.height>0?innerHeight/bounds.height:1);
  const actualWidth=bounds.width*scale,actualHeight=bounds.height*scale;
  // Let the contour enter the authored text columns. Bias toward the reading
  // side instead of centering in a separate, empty half of the composition.
  const x=laneLeft+(laneWidth-actualWidth)*(spec.side==='right'?.12:.84);
  const desiredY=top+innerHeight*spec.vertical-actualHeight/2;
  const y=Math.max(top,Math.min(bottom-actualHeight,desiredY));
  const cx=x-bounds.left*scale,cy=y-bounds.top*scale;
  const radii=cornerRadii(spec.width,spec.height,spec.radii);
  const endpoint:SequenceEndpoint={
    // Preserve the authored endpoint's original transform order exactly.
    nodes:transformFrameNodes(local,{scaleX:scale,scaleY:scale,translateX:cx,translateY:cy}),
    geometry:{x:cx,y:cy,width:spec.width*scale,height:spec.height*scale,rotation:spec.rotation,
      radii:Object.fromEntries(CORNERS.map(key=>[key,radii[key]*scale])) as FrameRadii},
  };
  return snapEndpoint(endpoint,w,h,{left:laneLeft,right:laneRight});
}

/** Exact ideal rounded-rectangle bounds need just four corner arcs. This
 * avoids running a cubic-extrema solver over all 64 anchors on every frame.
 * The renderer's short circular cubics differ by much less than a pixel.
 */
function geometryBounds(g:WindowGeometry) {
  const angle=g.rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const hw=g.width/2,hh=g.height/2;
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  const include=(x:number,y:number)=>{left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);};
  const arc=(x:number,y:number,r:number,start:number)=>{
    const cx=x*cos-y*sin,cy=x*sin+y*cos;
    const from=start+angle,to=from+Math.PI/2;
    include(cx+r*Math.cos(from),cy+r*Math.sin(from));
    include(cx+r*Math.cos(to),cy+r*Math.sin(to));
    for(let cardinal=Math.ceil(from/(Math.PI/2));cardinal*Math.PI/2<to;cardinal++) {
      const a=cardinal*Math.PI/2;include(cx+r*Math.cos(a),cy+r*Math.sin(a));
    }
  };
  const r=g.radii;
  arc(hw-r.bottomRight,hh-r.bottomRight,r.bottomRight,0);
  arc(-hw+r.bottomLeft,hh-r.bottomLeft,r.bottomLeft,Math.PI/2);
  arc(-hw+r.topLeft,-hh+r.topLeft,r.topLeft,Math.PI);
  arc(hw-r.topRight,-hh+r.topRight,r.topRight,Math.PI*1.5);
  return {left,top,right,bottom};
}

const mix=(a:number,b:number,t:number)=>a+(b-a)*t;

/** Morph the object, rather than each Bézier handle independently. Width,
 * height, pose, and corner roundness remain coherent through every midpoint.
 * Normalized radii let a circle open into a square without a pinched shoulder.
 */
function morphGeometry(from:WindowGeometry,to:WindowGeometry,t:number,width:number,height:number,shrink:number):FrameNodes {
  const w=dimension(width),h=dimension(height);
  const nextWidth=mix(from.width,to.width,t),nextHeight=mix(from.height,to.height,t);
  const fromCap=Math.min(from.width,from.height)/2,toCap=Math.min(to.width,to.height)/2;
  const cap=Math.min(nextWidth,nextHeight)/2;
  const radii=Object.fromEntries(CORNERS.map(key=>[key,cap*mix(fromCap?from.radii[key]/fromCap:0,
    toCap?to.radii[key]/toCap:0,t)])) as FrameRadii;
  const rotationDelta=((to.rotation-from.rotation+540)%360)-180;
  // Cross the reading lanes near the smallest contour, after the outgoing
  // copy has risen clear and before the next paragraph enters. This uses the
  // same reversible scroll playhead, not a delayed animation clock.
  const crossing=smoothstep(Math.max(0,Math.min(1,(t-.25)/.5)));
  const geometry:WindowGeometry={x:mix(from.x,to.x,crossing),y:mix(from.y,to.y,t),width:nextWidth,height:nextHeight,
    rotation:from.rotation+rotationDelta*t,radii};
  const bounds=geometryBounds(geometry);
  const {left,right}=philosophyReadingBounds(w);
  const top=Math.min(96,h),bottom=Math.max(top,h-40);
  const boundWidth=bounds.right-bounds.left,boundHeight=bounds.bottom-bounds.top;
  const scale=Math.min(1,boundWidth>0?(right-left)/boundWidth:1,boundHeight>0?(bottom-top)/boundHeight:1);
  const x=Math.max(left-bounds.left*scale,Math.min(right-bounds.right*scale,geometry.x));
  const y=Math.max(top-bounds.top*scale,Math.min(bottom-bounds.bottom*scale,geometry.y));
  // Keep the established center/clearance path; only open up space around it.
  const travelScale=scale*frameTransitionScale(t,shrink);
  return transformFrameNodes(roundedFrameNodes({left:-nextWidth/2,top:-nextHeight/2,
    right:nextWidth/2,bottom:nextHeight/2},radii),{scaleX:travelScale,scaleY:travelScale,rotation:geometry.rotation,
    translateX:x,translateY:y});
}

/** 0 cover · 1 introduction · 2 result · 3 product · 4 interface · 5 person.
 * One continuous, reversible contour; exact endpoint nodes never drift.
 */
export function philosophySequenceNodes(width:number,height:number,position:number,shrink=DEFAULT_FRAME_SHRINK):FrameNodes {
  const amount=positionInSequence(position),index=Math.floor(amount);
  const start=sequenceEndpoint(width,height,index);
  if(index===5||amount===index)return start.nodes;
  return morphGeometry(start.geometry,sequenceEndpoint(width,height,index+1).geometry,smoothstep(amount-index),width,height,shrink);
}

/** Compile viewport-dependent endpoints and their shape parameters once.
 * Intermediate contours retain circular corners and parallel opposing edges;
 * the shared renderer and text flow still consume the same 64 cubic anchors.
 * Recreate on viewport changes. Returned endpoint nodes are read-only inputs.
 */
export function createPhilosophySequence(width:number,height:number):(position:number,shrink?:number)=>FrameNodes {
  const endpoints=Array.from({length:6},(_,index)=>sequenceEndpoint(width,height,index));
  return (position:number,shrink=DEFAULT_FRAME_SHRINK):FrameNodes => {
    const amount=positionInSequence(position),index=Math.floor(amount);
    if(index===5||amount===index)return endpoints[index].nodes;
    return morphGeometry(endpoints[index].geometry,endpoints[index+1].geometry,smoothstep(amount-index),width,height,shrink);
  };
}

/** Sample the very same cubic nodes used by DynamicFrame. Accepting the nodes
 * keeps text avoidance and rendering on one geometry calculation per frame.
 */
export function philosophySequenceContour(nodes:readonly ApertureNode[]):PhilosophyPoint[] {
  const samples=6;
  return nodes.flatMap((node,index)=>{
    const next=nodes[(index+1)%nodes.length];
    return Array.from({length:samples},(_,sample)=>{
      const t=sample/samples,u=1-t;
      return {
        x:u**3*node.point.x+3*u*u*t*node.out.x+3*u*t*t*next.in.x+t**3*next.point.x,
        y:u**3*node.point.y+3*u*u*t*node.out.y+3*u*t*t*next.in.y+t**3*next.point.y,
      };
    });
  });
}
