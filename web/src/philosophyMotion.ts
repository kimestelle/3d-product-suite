/** The actual scroll offset is the single playhead for text and contour.
 * Stops retain fractional layout coordinates, including the header inset.
 */
export function philosophyScrollProgress(scroll:number,stops:readonly number[]):number {
  if(stops.length<2||!Number.isFinite(scroll)||scroll<=stops[0])return 0;
  for(let i=0;i<stops.length-1;i++) {
    if(scroll<stops[i+1])return i+(scroll-stops[i])/(stops[i+1]-stops[i]);
  }
  return stops.length-1;
}
