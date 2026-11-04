import type {WebGLRenderer} from 'three';

/** Stay within a two-sample budget for the HDR color + real depth target.
 * General MAX_SAMPLES does not prove that these attachment formats support it. */
export function previewPostSamples(renderer:WebGLRenderer):number {
  if((renderer.capabilities?.maxSamples??0)<2)return 0;
  const gl=renderer.getContext() as WebGL2RenderingContext;
  if(typeof gl.getInternalformatParameter!=='function')return 0;
  try {
    const color=Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,gl.RGBA16F,gl.SAMPLES) as Int32Array);
    const depth=Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER,gl.DEPTH_COMPONENT24,gl.SAMPLES) as Int32Array);
    return color.includes(2)&&depth.includes(2)?2:0;
  } catch {return 0;}
}
