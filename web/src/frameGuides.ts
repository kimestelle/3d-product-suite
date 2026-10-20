import {frameBounds,type FrameNodes} from './frameGeometry';
import './frame-guides.css';

/** Four rules through the displayed curve's true extrema. These coordinates
 * also define the studio viewport edges, so no second grid can drift from it. */
export function frameGuidePaths(nodes:FrameNodes,width:number,height:number,bounds=frameBounds(nodes)):{lines:string;crosses:string} {
  if(bounds.width<1||bounds.height<1||width<=0||height<=0)return {lines:'',crosses:''};
  const n=(value:number)=>Number(value.toFixed(3));
  const {left,top,right,bottom}=bounds;
  const crosses=[[left,top],[right,top],[left,bottom],[right,bottom]]
    .map(([x,y])=>`M ${n(x-4)} ${n(y)} H ${n(x+4)} M ${n(x)} ${n(y-4)} V ${n(y+4)}`).join(' ');
  return {lines:`M ${n(left)} 0 V ${n(height)} M ${n(right)} 0 V ${n(height)} M 0 ${n(top)} H ${n(width)} M 0 ${n(bottom)} H ${n(width)}`,crosses};
}

export function frameGuidePath(nodes:FrameNodes,width:number,height:number):string {
  return frameGuidePaths(nodes,width,height).lines;
}
