/** Display-referred grading shared by preview controls and export recipes.
 * All scene inputs remain linear; this recipe runs once after the display transform. */
export interface PostProcessingSettings {
  enabled:boolean;
  exposureEV:number;
  contrast:number;
  saturation:number;
  temperature:number;
  tint:number;
  highlights:number;
  shadows:number;
  vignette:number;
  grain:number;
  bloom:number;
}
export type PostProcessingNumber = Exclude<keyof PostProcessingSettings,'enabled'>;
export const POST_PROCESSING_LIMITS:Record<PostProcessingNumber,readonly [number,number]> = {
  exposureEV:[-3,3],contrast:[.5,1.5],saturation:[0,2],temperature:[-1,1],tint:[-1,1],
  highlights:[-1,1],shadows:[-1,1],vignette:[0,1],grain:[0,.15],bloom:[0,1],
};
export const DEFAULT_POST_PROCESSING:Readonly<PostProcessingSettings> = Object.freeze({
  enabled:false,exposureEV:0,contrast:1,saturation:1,temperature:0,tint:0,
  highlights:0,shadows:0,vignette:0,grain:0,bloom:0,
});
const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
export function resolvePostProcessing(value?:Partial<PostProcessingSettings>|null):PostProcessingSettings {
  const settings={...DEFAULT_POST_PROCESSING,enabled:value?.enabled===true};
  for(const key of Object.keys(POST_PROCESSING_LIMITS) as PostProcessingNumber[]){
    const number=value?.[key],range=POST_PROCESSING_LIMITS[key];
    settings[key]=typeof number==='number'&&Number.isFinite(number)?clamp(number,...range):DEFAULT_POST_PROCESSING[key];
  }
  return settings;
}
export function postProcessingIsNeutral(value?:Partial<PostProcessingSettings>|null):boolean {
  const settings=resolvePostProcessing(value);
  return !settings.enabled||(Object.keys(POST_PROCESSING_LIMITS) as PostProcessingNumber[])
    .every(key=>settings[key]===DEFAULT_POST_PROCESSING[key]);
}
const luma=(rgb:readonly number[])=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
/** Pure reference math for color grading. Spatial effects are applied separately. */
export function gradeDisplayRGB(rgb:readonly number[],value?:Partial<PostProcessingSettings>|null):[number,number,number] {
  const s=resolvePostProcessing(value);
  if(!s.enabled)return [rgb[0],rgb[1],rgb[2]];
  const exposure=2**s.exposureEV,gains=[1+.12*s.temperature,1+.06*s.tint,1-.12*s.temperature];
  let c=rgb.map((channel,index)=>channel*exposure*gains[index]);
  const y=luma(c.map(channel=>clamp(channel)));
  const lift=s.shadows*.18*(1-y)**2+s.highlights*.18*y**2;
  c=c.map(channel=>(channel+lift-.5)*s.contrast+.5);
  const gray=luma(c);
  return c.map(channel=>clamp(gray+(channel-gray)*s.saturation)) as [number,number,number];
}
export interface PostProcessingAnalysis {
  meanRGB:[number,number,number];
  medianLuma:number;
  p10Luma:number;
  p90Luma:number;
  clippedFraction:number;
  sampleCount:number;
}
/** Measure one ungraded display-sRGB snapshot. Alpha-zero pixels are not scene evidence. */
export function analyzeDisplayPixels(pixels:ArrayLike<number>):PostProcessingAnalysis {
  const histogram=new Uint32Array(1024),mean=[0,0,0];let count=0,clipped=0;
  for(let offset=0;offset+3<pixels.length;offset+=4){
    if(pixels[offset+3]<128)continue;
    const rgb=[pixels[offset],pixels[offset+1],pixels[offset+2]].map(channel=>clamp(channel/255));
    if(!rgb.every(Number.isFinite))continue;
    rgb.forEach((channel,index)=>mean[index]+=channel);count++;
    histogram[Math.round(luma(rgb)*1023)]++;
    if(rgb.some(channel=>channel>=.985))clipped++;
  }
  if(count<16)throw new Error('The preview has too few visible pixels to balance. Wait for the scene to load.');
  const quantile=(fraction:number)=>{const target=Math.ceil(count*fraction);let seen=0;for(let i=0;i<histogram.length;i++){seen+=histogram[i];if(seen>=target)return i/1023;}return 1;};
  return {meanRGB:mean.map(value=>value/count) as [number,number,number],medianLuma:quantile(.5),p10Luma:quantile(.1),p90Luma:quantile(.9),clippedFraction:clipped/count,sampleCount:count};
}
/** One bounded recommendation, frozen into scene values. Repeated frames do not
 * adapt, so an orbit cannot pump exposure or chase a deliberately colored room. */
export function suggestAutoBalance(analysis:PostProcessingAnalysis,current?:Partial<PostProcessingSettings>|null):PostProcessingSettings {
  const values=[...analysis.meanRGB,analysis.medianLuma,analysis.p10Luma,analysis.p90Luma,analysis.clippedFraction];
  if(analysis.sampleCount<16||!Number.isSafeInteger(analysis.sampleCount)||!values.every(value=>Number.isFinite(value)&&value>=0&&value<=1)
    ||analysis.p10Luma>analysis.medianLuma||analysis.medianLuma>analysis.p90Luma)
    throw new Error('The preview could not be measured. Wait for the scene to load and try again.');
  const median=Math.max(.03,analysis.medianLuma);
  const headroom=analysis.p90Luma>.92?0:.75;
  const exposureEV=clamp(Math.log2(.42/median),-.75,headroom);
  const [red,green,blue]=analysis.meanRGB,average=(red+green+blue)/3;
  // Keep neutralization small: room pigments and product colors are authored evidence.
  const temperature=clamp((blue-red)/Math.max(.1,average)*.6,-.25,.25);
  const tint=clamp(((red+blue)/2-green)/Math.max(.1,average)*.6,-.25,.25);
  return resolvePostProcessing({...resolvePostProcessing(current),enabled:true,
    exposureEV:Math.round(exposureEV*100)/100,temperature:Math.round(temperature*100)/100,tint:Math.round(tint*100)/100,
    highlights:analysis.clippedFraction>.02?-.25:analysis.p90Luma>.90?-.12:0,
    shadows:analysis.p10Luma<.07&&analysis.medianLuma<.35?.15:0,
  });
}
