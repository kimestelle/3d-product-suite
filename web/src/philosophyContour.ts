import type {ContourSpan,PhilosophyPoint} from './philosophyFlow';

export type ContourQuery = (top:number,bottom:number)=>ContourSpan|null;

/** Prepare one immutable contour for the many text bands measured against it.
 * Validation and edge bounds are shared by every query. Crossings are still
 * calculated at the exact band edges, including bands with no contour vertices.
 */
export function createContourQuery(points:readonly PhilosophyPoint[]):ContourQuery {
  if(!points.length)return ()=>null;
  const stride=6,edges=new Float64Array(points.length*stride);
  let contourTop=Infinity,contourBottom=-Infinity;
  for(let i=0;i<points.length;i++) {
    const a=points[i],b=points[(i+1)%points.length];
    if(!Number.isFinite(a.x)||!Number.isFinite(a.y))return ()=>null;
    const offset=i*stride;
    edges[offset]=a.x;edges[offset+1]=a.y;
    edges[offset+2]=b.x-a.x;edges[offset+3]=b.y-a.y;
    edges[offset+4]=Math.min(a.y,b.y);edges[offset+5]=Math.max(a.y,b.y);
    contourTop=Math.min(contourTop,a.y);contourBottom=Math.max(contourBottom,a.y);
  }
  return (top,bottom)=>{
    if(!Number.isFinite(top)||!Number.isFinite(bottom))return null;
    const low=Math.min(top,bottom),high=Math.max(top,bottom);
    if(high<contourTop||low>contourBottom)return null;
    let left=Infinity,right=-Infinity;
    for(let i=0;i<edges.length;i+=stride) {
      const minY=edges[i+4],maxY=edges[i+5];
      if(maxY<low||minY>high)continue;
      const ax=edges[i],ay=edges[i+1],dx=edges[i+2],dy=edges[i+3];
      if(ay>=low&&ay<=high){left=Math.min(left,ax);right=Math.max(right,ax);}
      if(dy===0)continue;
      if(low>=minY&&low<=maxY) {
        const x=ax+dx*((low-ay)/dy);
        left=Math.min(left,x);right=Math.max(right,x);
      }
      if(high>=minY&&high<=maxY) {
        const x=ax+dx*((high-ay)/dy);
        left=Math.min(left,x);right=Math.max(right,x);
      }
    }
    return left===Infinity?null:{left,right};
  };
}
