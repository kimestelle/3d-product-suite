// Optical measurements of the guide's Halyard Display signature at 200 px.
export const WORDMARK_STYLE = {weight:500, trackingEm:-.05, ringScale:1.02, strokeScale:.9} as const;
const em=200, ascent=96.115623, descent=1.715630, prefixDescent=48.312531;
const centerX=378.200134 + 4*em*WORDMARK_STYLE.trackingEm + 53.153123;
const centerY=(descent-ascent)/2;
const outer=(ascent+descent)*WORDMARK_STYLE.ringScale/2;
const inner=outer-25.1*WORDMARK_STYLE.strokeScale;
const top=centerY-outer;
const width=centerX+outer, height=prefixDescent-top;
const circle=(r:number, sweep:0|1)=>
  `M${centerX} ${centerY-r}a${r} ${r} 0 1 ${sweep} 0 ${2*r}a${r} ${r} 0 1 ${sweep} 0 ${-2*r}Z`;

export const GESSO_WORDMARK = {
  ...WORDMARK_STYLE, em, width, height, viewBox:`0 ${top} ${width} ${height}`, ring:circle(outer,0)+' '+circle(inner,1)
};
