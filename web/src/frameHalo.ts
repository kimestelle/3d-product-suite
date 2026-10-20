import {type FrameBounds} from './frameGeometry';

export type FrameHaloBounds={x:number;y:number;width:number;height:number};

/** Blur is measured in viewport pixels even when the contour contracts or
 * turns edge-on. Keep its filter region in those same units, including the
 * vector stroke and a rasterization guard beyond four standard deviations. */
export function frameHaloRegion(bounds:FrameBounds,blur:number,spread:number):FrameHaloBounds {
  const positive=(value:number)=>Number.isFinite(value)?Math.max(0,value):0;
  const padding=positive(spread)+4*positive(blur)+2;
  const x=Math.floor(bounds.left-padding),y=Math.floor(bounds.top-padding);
  return {x,y,width:Math.ceil(bounds.right+padding)-x,height:Math.ceil(bounds.bottom+padding)-y};
}
