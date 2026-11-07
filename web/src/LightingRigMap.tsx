import {colorHex, lightType, type StudioLight} from './world';
import './lighting-rig-map.css';

export default function LightingRigMap({lights, selected, onSelect}:{lights:StudioLight[];selected?:string;onSelect:(id:string)=>void}) {
  const coordinates=lights.flatMap(light=>[light.positionM,light.targetM]);
  const extents=[0,2].map(axis=>{
    const values=coordinates.map(point=>point[axis]);
    const low=Math.min(...values), high=Math.max(...values);
    return {center:(low+high)/2,span:high-low};
  });
  const scale=70/Math.max(.01,...extents.map(axis=>axis.span));
  const project=(point:number[])=>[50+(point[0]-extents[0].center)*scale,50+(point[2]-extents[1].center)*scale];
  const placed:number[][]=[];
  const slots=[15,38,62,85].flatMap(x=>[16,40,64,84].map(y=>[x,y]));
  const pins=lights.map(light=>{
    const origin=project(light.positionM);
    const [x,y]=[origin,...slots].sort((a,b)=>Math.hypot(a[0]-origin[0],a[1]-origin[1])-Math.hypot(b[0]-origin[0],b[1]-origin[1]))
      .find(point=>placed.every(other=>Math.abs(point[0]-other[0])>=19||Math.abs(point[1]-other[1])>=23))??origin;
    placed.push([x,y]);
    return {light,x,y,origin};
  });
  return <div className="gesso-light-rig-map" role="group" aria-label="Lighting rig · top view">
    <svg className="gesso-light-rig-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {pins.map(({light,x,y,origin:[ox,oy]})=>{
        const [tx,ty]=project(light.targetM);
        return <g key={light.id} opacity={light.id===selected?1:.27} stroke={colorHex(light.color)}>
          <line x1={ox} y1={oy} x2={tx} y2={ty} vectorEffect="non-scaling-stroke"/>
          {(x!==ox||y!==oy)&&<line x1={x} y1={y} x2={ox} y2={oy} strokeDasharray="2 2" vectorEffect="non-scaling-stroke"/>}
          <circle cx={tx} cy={ty} r="1" fill="none"/>
        </g>;
      })}
    </svg>
    {pins.map(({light,x,y})=>{
      const type=light.waterRipple?'Ripple spot':lightType(light)==='spot'?'Spot':'Area';
      return <button key={light.id} type="button" aria-pressed={light.id===selected}
        aria-label={`Select ${light.name} · ${type}${light.enabled?'':' · Off'}`} title={`${light.name} · ${type}`}
        data-off={!light.enabled} style={{left:`${x}%`,top:`${y}%`,color:colorHex(light.color)}} onClick={()=>onSelect(light.id)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          {type==='Area'?<circle cx="10" cy="10" r="5.5"/>:type==='Spot'?<path d="M10 4 16 15H4Z"/>:<path d="M3 7q3-4 7 0t7 0M3 13q3-4 7 0t7 0"/>}
        </svg>
      </button>;
    })}
    <span>Top view</span>
  </div>;
}
