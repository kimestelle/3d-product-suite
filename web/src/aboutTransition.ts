import {landingMorphNodes, type ApertureNode, type AperturePoint} from './landingMorph';
import {entranceEase, type EntranceOrigin} from './studioEntrance';

export const ABOUT_DURATION = 680;
export function aboutPanelBounds(width: number, height: number) {
  const mobile = width <= 760;
  const left = mobile ? 16 : 40, top = mobile ? 80 : 81;
  return {left, top, right: Math.max(left + 1, width - left), bottom: Math.max(top + 1, height), radius: Math.min(mobile ? 28 : 40, Math.max(1, (width - left * 2) / 2), Math.max(1, (height - top) / 2))};
}
const point = (x: number, y: number): AperturePoint => ({x, y});
const mix = (a: AperturePoint, b: AperturePoint, amount: number): AperturePoint => point(a.x + (b.x-a.x)*amount, a.y + (b.y-a.y)*amount);

/** One exact panel perimeter, including its square bottom corners, in 64 cubics. */
export function aboutPanelNodes(width: number, height: number): ApertureNode[] {
  const {left, top, right, bottom, radius:r} = aboutPanelBounds(width, height);
  const cx = (left+right)/2, cy = (top+bottom)/2;
  const nodes: ApertureNode[] = [];
  let incoming: AperturePoint | null = null;
  const cubic = (start:AperturePoint, first:AperturePoint, second:AperturePoint, end:AperturePoint) => {
    nodes.push({point:start, in:incoming ?? start, out:first});
    incoming=second;
    // The final edge supplies the first node's incoming handle below.
    return end;
  };
  const line = (start:AperturePoint, end:AperturePoint, count:number) => {
    for(let i=0;i<count;i++) {
      const a=mix(start,end,i/count), b=mix(start,end,(i+1)/count);
      cubic(a,mix(a,b,1/3),mix(a,b,2/3),b);
    }
  };
  const arc = (center:AperturePoint, from:number, to:number) => {
    const count=4, step=(to-from)/count, handle=4/3*Math.tan(step/4)*r;
    for(let i=0;i<count;i++) {
      const a=from+i*step,b=a+step;
      const start=point(center.x+r*Math.cos(a),center.y+r*Math.sin(a));
      const end=point(center.x+r*Math.cos(b),center.y+r*Math.sin(b));
      cubic(start,point(start.x-handle*Math.sin(a),start.y+handle*Math.cos(a)),point(end.x+handle*Math.sin(b),end.y-handle*Math.cos(b)),end);
    }
  };
  line(point(right,cy),point(right,bottom),8);
  line(point(right,bottom),point(cx,bottom),8);
  line(point(cx,bottom),point(left,bottom),8);
  line(point(left,bottom),point(left,cy),8);
  line(point(left,cy),point(left,top+r),6);
  arc(point(left+r,top+r),Math.PI,Math.PI*1.5);
  line(point(left+r,top),point(cx,top),6);
  line(point(cx,top),point(right-r,top),6);
  arc(point(right-r,top+r),Math.PI*1.5,Math.PI*2);
  line(point(right,top+r),point(right,cy),6);
  nodes[0].in=incoming!;
  return nodes;
}

export function aboutTransitionNodes(origin:EntranceOrigin, progress:number): ApertureNode[] {
  const amount=entranceEase(Number.isFinite(progress)?progress:0);
  const scale=origin.width/1000;
  const project=(p:AperturePoint)=>point(origin.x+(p.x-500)*scale,origin.y+(p.y-300)*scale);
  const target=aboutPanelNodes(origin.viewportWidth,origin.viewportHeight);
  if(amount===1)return target;
  return landingMorphNodes(origin.aperture).map((node,i)=>({
    point:mix(project(node.point),target[i].point,amount),
    in:mix(project(node.in),target[i].in,amount),
    out:mix(project(node.out),target[i].out,amount),
  }));
}

/** CSS paths use viewport pixels; the live landing SVG uses its original local units. */
export function aboutTransitionPath(origin:EntranceOrigin,progress:number,space:'viewport'|'landing'='viewport'):string {
  const nodes=aboutTransitionNodes(origin,progress),scale=origin.width/1000;
  const coordinates=(p:AperturePoint)=>{
    const x=space==='landing'?(p.x-origin.x)/scale+500:p.x;
    const y=space==='landing'?(p.y-origin.y)/scale+300:p.y;
    return `${Math.round(x*1000)/1000} ${Math.round(y*1000)/1000}`;
  };
  let path=`M ${coordinates(nodes[0].point)}`;
  for(let i=0;i<nodes.length;i++) {
    const next=nodes[(i+1)%nodes.length];
    path+=` C ${coordinates(nodes[i].out)} ${coordinates(next.in)} ${coordinates(next.point)}`;
  }
  return `${path} Z`;
}
