type Point = {x:number;y:number};
type Circle = Point & {r:number};
type Tangent = {near:Point;far:Point};
export type ExpansionOptions = {
  cx:number;cy:number;nearRadius:number;farRadius:number;distance:number;angle:number;
};
export type ExpansionGeometry = {
  path:string;near:Circle;far:Circle;tangents:[Tangent,Tangent];
};

/** Optical registration: keep the subject fixed and move the world back along
 * its own axis. The offset is a design choice in drawing units, not a centroid. */
export function balanceExpansionOrigin<T extends {cx:number;cy:number;angle:number}>(options:T,offset:number):T {
  const radians=options.angle*Math.PI/180;
  return {...options,cx:options.cx-offset*Math.cos(radians),cy:options.cy-offset*Math.sin(radians)};
}

/** Convex hull of two circles, made only from exact external tangent lines
 * and their exposed circular arcs. Angle is in degrees: 0 points right;
 * positive angles turn clockwise in SVG's downward-positive y axis.
 * Containment is rejected because it has no distinct two-tangent hull. */
export function expansionGeometry(options:ExpansionOptions):ExpansionGeometry {
  if(!options||typeof options!=='object')throw new TypeError('Expansion geometry requires an options object.');
  for(const key of ['cx','cy','nearRadius','farRadius','distance','angle'] as const) {
    if(!Number.isFinite(options[key]))throw new RangeError(`Expansion geometry: ${key} must be finite.`);
  }
  const {cx,cy,nearRadius,farRadius,distance,angle}=options;
  if(nearRadius<=0||farRadius<=0)throw new RangeError('Expansion geometry: both circle radii must be greater than zero.');
  if(distance<=Math.abs(farRadius-nearRadius)) {
    throw new RangeError('Expansion geometry requires distance > |farRadius - nearRadius| so both circles have exposed arcs and two distinct common external tangents.');
  }
  const radians=(angle%360)*Math.PI/180;
  const ux=Math.cos(radians),uy=Math.sin(radians);
  const near:Circle={x:cx,y:cy,r:nearRadius};
  const far:Circle={x:cx+distance*ux,y:cy+distance*uy,r:farRadius};
  // On a common support line Cnear·n+rnear = Cfar·n+rfar.
  // Thus u·n = (rnear-rfar)/distance; the two perpendicular
  // signs give its two unit normals without a slope singularity.
  const along=(nearRadius-farRadius)/distance;
  const across=Math.sqrt((1-along)*(1+along));
  const tangent=(side:1|-1):Tangent=>{
    const nx=along*ux-side*across*uy;
    const ny=along*uy+side*across*ux;
    return {
      near:{x:cx+nearRadius*nx,y:cy+nearRadius*ny},
      far:{x:far.x+farRadius*nx,y:far.y+farRadius*ny},
    };
  };
  const tangents:[Tangent,Tangent]=[tangent(1),tangent(-1)];
  if([near,far,...tangents.flatMap(t=>[t.near,t.far])].some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y))) {
    throw new RangeError('Expansion geometry: circle centers or tangent endpoints overflow finite coordinates.');
  }
  const [plus,minus]=tangents;
  const point=(p:Point)=>`${p.x} ${p.y}`;
  // Both arcs run with sweep=0. The larger circle contributes an arc
  // greater than 180°; equal-radius circles each contribute exactly 180°.
  const path=`M ${point(plus.near)} L ${point(plus.far)} A ${farRadius} ${farRadius} 0 ${farRadius>nearRadius?1:0} 0 ${point(minus.far)} L ${point(minus.near)} A ${nearRadius} ${nearRadius} 0 ${nearRadius>farRadius?1:0} 0 ${point(plus.near)} Z`;
  return {path,near,far,tangents};
}
