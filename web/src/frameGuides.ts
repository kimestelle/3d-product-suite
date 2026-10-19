import {frameBounds,type FrameNodes} from './frameGeometry';
import './frame-guides.css';

/** Four rules through the displayed curve's true extrema. These coordinates
 * also define the studio viewport edges, so no second grid can drift from it. */
export function frameGuidePath(nodes:FrameNodes,width:number,height:number):string {
  const bounds=frameBounds(nodes);
  if(bounds.width<1||bounds.height<1||width<=0||height<=0)return '';
  const n=(value:number)=>Number(value.toFixed(3));
  const {left,top,right,bottom}=bounds;
  return `M ${n(left)} 0 V ${n(height)} M ${n(right)} 0 V ${n(height)} M 0 ${n(top)} H ${n(width)} M 0 ${n(bottom)} H ${n(width)}`;
}
