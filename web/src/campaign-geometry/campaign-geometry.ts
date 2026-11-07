import {projectedField} from './scene-field-geometry';
import {WORLD_SHAPES,getWorldGeometry,type WorldShape} from './nested-geometry';
import {framePath,type FrameNodes} from '../frameGeometry';
import {expansionGeometry} from './registered-expansion';

type Point={x:number;y:number};
export type CampaignFieldOptions={
  shape?:WorldShape;cx:number;cy:number;targetX:number;targetY:number;productRadius:number;
  farScale?:number;farRadius?:number;opticalOffset?:number;rotation?:number;
};
export type CampaignField={
  path:string;localPath:string;outerPath:string;parts:string[];compactPath:string;nearPath:string;farPath:string;openingPath:string;
  transform:string;fillRule:'nonzero';rotation:number;
  productRadius:number;openingRadius:number;nearRadius:number;farRadius:number;farScale:number;
  nearCenter:Point;farCenter:Point;
  tangents:Array<{near:Point;far:Point}>;
  diagnostics:{method:string;contained:boolean;maxAngleErrorDegrees:number;maxSupportError:number;supportTolerance:number;contactTypes:string[]};
};
const finite=(name:string,value:number)=>{
  if(!Number.isFinite(value))throw new RangeError(`Campaign field: ${name} must be finite.`);
  return value;
};
const normalized=new Map<WorldShape,FrameNodes>();
function nativeSection(shape:WorldShape):FrameNodes {
  const cached=normalized.get(shape);if(cached)return cached;
  const source=getWorldGeometry(shape),scale=135/source.minimumRadius;
  const point=(p:Point)=>({x:(p.x-500)*scale,y:(p.y-300)*scale});
  const nodes=source.nodes.map(node=>({point:point(node.point),in:point(node.in),out:point(node.out)}));
  normalized.set(shape,nodes);return nodes;
}
const nativePath=(nodes:FrameNodes,center:Point,scale=1)=>{
  const point=(p:Point)=>({x:center.x+p.x*scale,y:center.y+p.y*scale});
  return framePath(nodes.map(node=>({point:point(node.point),in:point(node.in),out:point(node.out)})));
};

type Cubic={coeff:Point[]};
type Contact={point:Point;normal:Point;kind:'curve'|'edge'|'corner';angleError:number;supportError:number};
const dot=(a:Point,b:Point)=>a.x*b.x+a.y*b.y;
const cross=(a:Point,b:Point)=>a.x*b.y-a.y*b.x;
const SUPPORT_TOLERANCE=2e-6;
const evaluate=(coeff:number[],t:number)=>coeff.reduceRight((result,value)=>result*t+value,0);
/** Derivative critical points partition each polynomial into monotone
 * intervals, so bisection finds every real root, including even roots. */
function roots(input:number[]):number[]{
  const magnitude=Math.max(...input.map(Math.abs));if(magnitude===0)return [];
  const coeff=input.map(value=>value/magnitude);
  while(coeff.length>1&&Math.abs(coeff[coeff.length-1])<1e-13)coeff.pop();
  if(coeff.length===1)return [];
  if(coeff.length===2){const t=-coeff[0]/coeff[1];return t>=-1e-11&&t<=1+1e-11?[Math.max(0,Math.min(1,t))]:[];}
  const critical=roots(coeff.slice(1).map((value,i)=>value*(i+1)));
  const stops=[0,...critical.filter(t=>t>0&&t<1),1].sort((a,b)=>a-b),result:number[]=[];
  const add=(t:number)=>{if(!result.some(value=>Math.abs(value-t)<1e-8))result.push(t);};
  for(const t of stops)if(Math.abs(evaluate(coeff,t))<2e-12)add(t);
  for(let i=0;i<stops.length-1;i++){
    let left=stops[i],right=stops[i+1],fl=evaluate(coeff,left),fr=evaluate(coeff,right);
    if(fl*fr>=0)continue;
    for(let j=0;j<60;j++){const mid=(left+right)/2,fm=evaluate(coeff,mid);if(fl*fm<=0){right=mid;fr=fm;}else{left=mid;fl=fm;}}
    add((left+right)/2);
  }return result.sort((a,b)=>a-b);
}
const cubicPoint=(c:Cubic,t:number):Point=>({x:evaluate(c.coeff.map(p=>p.x),t),y:evaluate(c.coeff.map(p=>p.y),t)});
const cubicDerivative=(c:Cubic,t:number):Point=>({x:evaluate(c.coeff.slice(1).map((p,i)=>p.x*(i+1)),t),y:evaluate(c.coeff.slice(1).map((p,i)=>p.y*(i+1)),t)});
const mathCache=new WeakMap<FrameNodes,Cubic[]>();
function cubics(nodes:FrameNodes):Cubic[]{
  const cached=mathCache.get(nodes);if(cached)return cached;
  const result=nodes.map((node,i)=>{
    const a=node.point,b=node.out,c=nodes[(i+1)%nodes.length].in,d=nodes[(i+1)%nodes.length].point;
    return {coeff:[a,{x:3*(b.x-a.x),y:3*(b.y-a.y)},
      {x:3*(a.x-2*b.x+c.x),y:3*(a.y-2*b.y+c.y)},
      {x:-a.x+3*b.x-3*c.x+d.x,y:-a.y+3*b.y-3*c.y+d.y}]};
  });mathCache.set(nodes,result);return result;
}
function support(curves:Cubic[],normal:Point):number{
  let maximum=-Infinity;
  for(const curve of curves){
    const values=curve.coeff.map(p=>dot(p,normal));
    for(const t of [0,1,...roots(values.slice(1).map((value,i)=>value*(i+1)))])maximum=Math.max(maximum,evaluate(values,t));
  }return maximum;
}
/** Exact native-curve ray test, using a ray not aligned with any anchor. */
function contains(curves:Cubic[],point:Point):boolean{
  let angle=.123456789;
  for(let attempt=0;attempt<12;attempt++,angle+=.137){
    const n={x:-Math.sin(angle),y:Math.cos(angle)};
    if(curves.every(curve=>Math.abs(dot(curve.coeff[0],n)-dot(point,n))>1e-8))break;
  }
  const along={x:Math.cos(angle),y:Math.sin(angle)},normal={x:-along.y,y:along.x};
  const py=dot(point,normal),px=dot(point,along);let winding=0;
  for(const curve of curves){
    const values=curve.coeff.map(p=>dot(p,normal));values[0]-=py;
    for(const t of roots(values)){
      const q=cubicPoint(curve,t),x=dot(q,along);if(Math.abs(x-px)<1e-7)return true;
      if(x<px||t>=1-1e-10)continue;
      const before=evaluate(values,Math.max(0,t-1e-6)),after=evaluate(values,Math.min(1,t+1e-6));
      if(before<0&&after>0)winding++;else if(before>0&&after<0)winding--;
    }
  }return winding!==0;
}
function nativeContacts(nodes:FrameNodes,delta:Point,scale:number,convex:boolean):{contacts:Contact[];contained:boolean}{
  const curves=cubics(nodes),h=scale-1,distance=Math.hypot(delta.x,delta.y);
  if(distance===0||convex&&h>0&&contains(curves,{x:-delta.x/h,y:-delta.y/h}))return {contacts:[],contained:true};
  const candidates:Contact[]=[];
  const add=(point:Point,normal:Point,kind:Contact['kind'],angleError:number)=>{
    const gap=Math.max(0,support(curves,normal)-dot(point,normal));
    if(gap<=SUPPORT_TOLERANCE&&angleError<=1e-5)candidates.push({point,normal,kind,angleError,supportError:gap});
  };
  for(const curve of curves){
    const tangent=curve.coeff.slice(1).map((p,i)=>({x:p.x*(i+1),y:p.y*(i+1)}));
    const separation=curve.coeff.map((p,i)=>({x:h*p.x+(i?0:delta.x),y:h*p.y+(i?0:delta.y)}));
    const polynomial=Array(6).fill(0) as number[];
    separation.forEach((a,i)=>tangent.forEach((b,j)=>polynomial[i+j]+=cross(a,b)));
    const flat=Math.max(...polynomial.map(Math.abs))<1e-10*Math.max(1,distance);
    for(const t of flat?[0,.5,1]:roots(polynomial)){
      const point=cubicPoint(curve,t),derivative=cubicDerivative(curve,t),speed=Math.hypot(derivative.x,derivative.y);
      const line={x:delta.x+h*point.x,y:delta.y+h*point.y},length=Math.hypot(line.x,line.y);
      if(speed<1e-10||length<1e-10)continue;
      const normal={x:derivative.y/speed,y:-derivative.x/speed};
      const angleError=Math.asin(Math.min(1,Math.abs(cross(line,derivative))/(length*speed)))*180/Math.PI;
      add(point,normal,flat?'edge':'curve',angleError);
    }
    // A sharp native corner has a cone of valid support normals. It need not
    // be a smooth-derivative root; the complete cubic support test decides.
    const point=curve.coeff[0],line={x:delta.x+h*point.x,y:delta.y+h*point.y},length=Math.hypot(line.x,line.y);
    if(length>1e-10)for(const sign of [-1,1])add(point,{x:sign*line.y/length,y:-sign*line.x/length},'corner',0);
  }
  // An anisotropic section's two normals need not straddle the center axis.
  // Group by the actual support normal, never by an assumed left/right sign.
  const groups=(list:Contact[])=>{
    const result:Contact[]=[];
    for(const candidate of list.slice().sort((a,b)=>a.supportError-b.supportError||a.angleError-b.angleError)){
      if(!result.some(other=>Math.hypot(other.normal.x-candidate.normal.x,other.normal.y-candidate.normal.y)<1e-7))result.push(candidate);
    }return result;
  };
  let unique=groups(candidates.filter(candidate=>candidate.kind!=='corner'));
  if(unique.length<2)unique=groups(candidates);
  if(unique.length<2)throw new Error('Campaign field: no verified pair of common support lines exists for this native contour and placement.');
  let contacts=[unique[0],unique[1]],separation=-1;
  for(let i=0;i<unique.length;i++)for(let j=i+1;j<unique.length;j++){
    const apart=Math.hypot(unique[i].normal.x-unique[j].normal.x,unique[i].normal.y-unique[j].normal.y);
    if(apart>separation){contacts=[unique[i],unique[j]];separation=apart;}
  }
  return {contacts,contained:false};
}

/** Native geometry is authored in its existing 74 / 92 / 135 coordinate
 * system, then uniformly projected to screen units. Common supports contact
 * the actual native cubic curves (or their original corners), not an interior
 * proxy circle. Circle retains its analytic construction. Concave shapes keep
 * their native sections; the connecting support quadrilateral may fill their
 * near-facing notches and does not carry the convex-boundary guarantee.
 * parts/outerPath use a nonzero union. Apply the circular opening AFTER this
 * union in a mask: evenodd would incorrectly punch holes through overlaps.
 * rotation rotates both native sections independently of the target axis.
 * nearRadius/farRadius are nominal section inradii, not polygon corner radii. */
export function campaignField(options:CampaignFieldOptions):CampaignField {
  if(!options||typeof options!=='object')throw new TypeError('Campaign field requires an options object.');
  const shape=options.shape??'hexagon';
  if(!WORLD_SHAPES.some(item=>item.id===shape))throw new RangeError('Campaign field shape must belong to the native WorldShape catalog.');
  const cx=finite('cx',options.cx),cy=finite('cy',options.cy);
  const targetX=finite('targetX',options.targetX),targetY=finite('targetY',options.targetY);
  const productRadius=finite('productRadius',options.productRadius),scale=productRadius/74;
  if(!(scale>0))throw new RangeError('Campaign field: productRadius must be greater than zero in representable drawing units.');
  const openingRadius=92*scale,nearRadius=135*scale;
  if(!Number.isFinite(openingRadius)||!Number.isFinite(nearRadius))throw new RangeError('Campaign field: scaled radii overflow finite drawing units.');
  if(options.farScale!==undefined&&options.farRadius!==undefined)throw new RangeError('Campaign field: provide either farScale or farRadius, not both.');
  const farScale=options.farRadius!==undefined?finite('farRadius',options.farRadius)/nearRadius:finite('farScale',options.farScale??2.45);
  if(!Number.isFinite(farScale)||farScale<1)throw new RangeError('Campaign field: the far section must be at least as large as the near section.');
  const farRadius=nearRadius*farScale;
  if(!Number.isFinite(farRadius))throw new RangeError('Campaign field: the far radius overflows finite drawing units.');
  const offset=finite('opticalOffset',options.opticalOffset??0),normalizedOffset=offset/scale;
  if(offset<0||normalizedOffset>43)throw new RangeError('Campaign field: opticalOffset must be between zero and 43 × productRadius / 74 to preserve the circular opening.');
  const dx=targetX-cx,dy=targetY-cy,distance=Math.hypot(dx,dy);
  if(!Number.isFinite(distance))throw new RangeError('Campaign field: target distance overflows finite drawing units.');
  if(distance===0&&offset!==0)throw new RangeError('Campaign field: a nonzero optical offset needs a distinct far target to define its axis.');
  const rotation=finite('rotation',options.rotation??0)%360;
  const angle=(distance?Math.atan2(dy,dx)*180/Math.PI:0)-rotation;
  // Increasing reach by the optical offset keeps the requested far endpoint
  // fixed while only the near construction center moves backward.
  const reach=(distance+offset)/scale;
  if(!Number.isFinite(reach))throw new RangeError('Campaign field: normalized target distance overflows finite drawing units.');
  let parts:string[],nearPath:string,farPath:string,compactPath:string,near:Point,far:Point;
  let localTangents:Array<{near:Point;far:Point}>=[];
  const diagnostics={method:shape==='circle'?'analytic circle':'native cubic common supports',contained:false,maxAngleErrorDegrees:0,maxSupportError:0,supportTolerance:SUPPORT_TOLERANCE*scale*farScale,contactTypes:[] as string[]};
  if(shape==='circle'){
    const geometry=projectedField({shape,cx:0,cy:0,progress:1,angle,distance:reach,farScale,opticalOffset:normalizedOffset});
    parts=[geometry.path];near=geometry.nearCenter;far=geometry.farCenter;nearPath=geometry.nearPath;farPath=geometry.farPath;
    compactPath=projectedField({shape,cx:0,cy:0,progress:0,angle:0,opticalOffset:0}).nearPath;
    diagnostics.contained=reach<=135*(farScale-1);
    if(!diagnostics.contained){localTangents=expansionGeometry({cx:near.x,cy:near.y,nearRadius:135,farRadius:135*farScale,distance:reach,angle}).tangents;diagnostics.contactTypes=['curve','curve'];}
  }else{
    const radians=angle*Math.PI/180,ux=Math.cos(radians),uy=Math.sin(radians);
    near={x:-normalizedOffset*ux,y:-normalizedOffset*uy};far={x:near.x+reach*ux,y:near.y+reach*uy};
    const nodes=nativeSection(shape);
    compactPath=nativePath(nodes,{x:0,y:0});nearPath=nativePath(nodes,near);farPath=nativePath(nodes,far,farScale);
    const solution=nativeContacts(nodes,{x:far.x-near.x,y:far.y-near.y},farScale,!['cross','plus','star'].includes(shape));
    diagnostics.contained=solution.contained;diagnostics.contactTypes=solution.contacts.map(contact=>contact.kind);
    diagnostics.maxAngleErrorDegrees=Math.max(0,...solution.contacts.map(contact=>contact.angleError));
    diagnostics.maxSupportError=Math.max(0,...solution.contacts.map(contact=>contact.supportError))*scale*farScale;
    localTangents=solution.contacts.map(contact=>({near:{x:near.x+contact.point.x,y:near.y+contact.point.y},far:{x:far.x+contact.point.x*farScale,y:far.y+contact.point.y*farScale}}));
    parts=solution.contained?[farPath]:[nearPath,farPath];
    if(localTangents.length){
      const vertices=[localTangents[0].near,localTangents[1].near,localTangents[1].far,localTangents[0].far];
      if(vertices.reduce((area,p,i)=>area+cross(p,vertices[(i+1)%vertices.length]),0)<0)vertices.reverse();
      parts.splice(1,0,`M ${vertices.map(p=>`${p.x} ${p.y}`).join(' L ')} Z`);
    }
  }
  const openingPath='M 92 0 A 92 92 0 1 0 -92 0 A 92 92 0 1 0 92 0 Z';
  const outerPath=parts.join(' '),localPath=outerPath;
  if(/NaN|Infinity/.test(outerPath+compactPath+nearPath+farPath))throw new RangeError('Campaign field: native geometry must serialize to a finite SVG path.');
  const radians=rotation*Math.PI/180,cos=Math.cos(radians),sin=Math.sin(radians);
  const screen=(p:Point):Point=>({x:cx+(p.x*cos-p.y*sin)*scale,y:cy+(p.x*sin+p.y*cos)*scale});
  const nearCenter=screen(near),farCenter=screen(far);
  if([nearCenter,farCenter].some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw new RangeError('Campaign field: transformed centers overflow finite screen units.');
  return {path:localPath,localPath,outerPath,parts,compactPath,nearPath,farPath,openingPath,
    transform:`translate(${cx} ${cy}) rotate(${rotation}) scale(${scale})`,fillRule:'nonzero',rotation,
    productRadius,openingRadius,nearRadius,farRadius,farScale,nearCenter,farCenter,
    tangents:localTangents.map(contact=>({near:screen(contact.near),far:screen(contact.far)})),diagnostics};
}
