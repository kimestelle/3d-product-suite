export type PhilosophyPoint = {x:number; y:number};
export type ContourSpan = {left:number; right:number};
export type PhilosophyGeometry = {x:number; y:number; width:number; height:number; radius:number; rotation:number};
const ARC_SEGMENTS = 24;
const usableDimension = (value:number) => Number.isFinite(value) ? Math.max(0,value) : 0;

/** Shared visual and collision geometry. x/y are the viewport-space center;
 * rotation is in degrees, matching the CSS transform.
 */
export function philosophyGeometry(viewportWidth:number,viewportHeight:number,progress:number):PhilosophyGeometry {
  const w=usableDimension(viewportWidth),h=usableDimension(viewportHeight);
  const p=Number.isNaN(progress)?0:Math.max(0,Math.min(1,progress));
  const initialScale=1-.04*(1-p);
  // Give the opening title more room; the padded bounds still cap the shift.
  const desiredX=w*(.53387045-.3049642*p+.02*(1-p))+Math.min(64,w*.04)*(1-p);
  const desiredY=h/2+w*(-.0012644+.2668894*p);
  let width=w*(.5118124+.1131876*p)*initialScale;
  let height=w*(.27712174+.34787826*p)*initialScale;
  let radius=Math.min(w*(.03125+.28125*p)*initialScale,width/2,height/2);
  const rotation=-30*(1-p),angle=rotation*Math.PI/180;
  const cos=Math.abs(Math.cos(angle)),sin=Math.abs(Math.sin(angle));
  // A rounded rectangle is its inner rectangle plus a circle. This support
  // function gives its exact rotated bounds, without reserving empty corners.
  let extentX=(width/2-radius)*cos+(height/2-radius)*sin+radius;
  let extentY=(width/2-radius)*sin+(height/2-radius)*cos+radius;
  // As the shape opens, preserve a readable column for the text on its right.
  // Smoothstep makes the reserve reversible and stationary at both endpoints.
  const lane=Math.min(480,Math.max(280,w*.36));
  const laneProgress=Math.min(1,p/.35);
  const reserve=(lane+24)*laneProgress*laneProgress*(3-2*laneProgress);
  const left=Math.min(40,w/2),right=Math.max(left,w-40-reserve);
  const top=Math.min(96,h),bottom=Math.max(top,h-40);
  const fit=Math.min(1,extentX>0?(right-left)/(2*extentX):1,
    extentY>0?(bottom-top)/(2*extentY):1);
  width*=fit;height*=fit;radius*=fit;extentX*=fit;extentY*=fit;
  const x=Math.max(left+extentX,Math.min(right-extentX,desiredX));
  const y=Math.max(top+extentY,Math.min(bottom-extentY,desiredY));
  return {x,y,width,height,radius,rotation};
}

/** Every sample lies on the shared rounded perimeter; straight edges join
 * consecutive corner arcs. The final point connects back to the first.
 */
export function philosophyContour(viewportWidth:number, viewportHeight:number, progress:number):PhilosophyPoint[] {
  const {x:cx,y:cy,width,height,radius,rotation}=philosophyGeometry(viewportWidth,viewportHeight,progress);
  const angle=rotation*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle);
  const halfWidth=width/2,halfHeight=height/2;
  const corners=[
    {x:halfWidth-radius,y:-halfHeight+radius,start:-Math.PI/2},
    {x:halfWidth-radius,y:halfHeight-radius,start:0},
    {x:-halfWidth+radius,y:halfHeight-radius,start:Math.PI/2},
    {x:-halfWidth+radius,y:-halfHeight+radius,start:Math.PI},
  ];
  return corners.flatMap(corner=>Array.from({length:ARC_SEGMENTS+1},(_,i)=>{
    const a=corner.start+Math.PI/2*i/ARC_SEGMENTS;
    const x=corner.x+radius*Math.cos(a),y=corner.y+radius*Math.sin(a);
    return {x:cx+x*cos-y*sin,y:cy+x*sin+y*cos};
  }));
}

/** Exact horizontal extent of the sampled polygon clipped to a vertical band.
 * Edge crossings matter: a band can cut through the shape without containing
 * any of its vertices. Swapped band bounds are accepted; invalid data is empty.
 */
export function contourSpan(contour:readonly PhilosophyPoint[],top:number,bottom:number):ContourSpan|null {
  if(!contour.length || !Number.isFinite(top) || !Number.isFinite(bottom)
    || contour.some(point=>!Number.isFinite(point.x)||!Number.isFinite(point.y)))return null;
  const low=Math.min(top,bottom),high=Math.max(top,bottom);
  let left=Infinity,right=-Infinity;
  const include=(x:number)=>{left=Math.min(left,x);right=Math.max(right,x);};
  for(let i=0;i<contour.length;i++) {
    const a=contour[i],b=contour[(i+1)%contour.length];
    if(a.y>=low&&a.y<=high)include(a.x);
    if(a.y===b.y)continue;
    for(const y of [low,high]) {
      if(y<Math.min(a.y,b.y)||y>Math.max(a.y,b.y))continue;
      const t=(y-a.y)/(b.y-a.y);
      include(a.x+(b.x-a.x)*t);
    }
  }
  return left===Infinity?null:{left,right};
}
