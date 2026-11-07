/** A role belongs to one glyph. Reuse these names instead of choosing icons at each call site. */
export const UI_ICON_CATALOG = [
  {name:'product', label:'Product', role:'The complete imported model', group:'Objects', lucide:'Box', size:16},
  {name:'part', label:'Part', role:'An editable member of the product', group:'Objects', lucide:'Component', size:16},
  {name:'stage', label:'Stage / world', role:'The environment around the product', group:'Objects', lucide:'Globe', size:16},
  {name:'camera', label:'Camera', role:'The saved view and its optical properties', group:'Objects', lucide:'Camera', size:16},
  {name:'light', label:'Light', role:'An editable light source', group:'Objects', lucide:'Lightbulb', size:16},
  {name:'material', label:'Material', role:'A surface finish and its maps', group:'Objects', lucide:'PaintBucket', size:16},
  {name:'scene', label:'Scene', role:'One timed segment of a film', group:'Objects', lucide:'Clapperboard', size:16},
  {name:'film', label:'Film', role:'The complete sequence', group:'Objects', lucide:'Film', size:16},
  {name:'move', label:'Move', role:'Change position in scene axes', group:'Transform', lucide:'Move3D', size:16},
  {name:'rotate', label:'Rotate', role:'Change orientation in scene axes', group:'Transform', lucide:'Rotate3D', size:16},
  {name:'scale', label:'Scale', role:'Change object dimensions', group:'Transform', lucide:'Scale3D', size:16},
  {name:'fitFrame', label:'Fit in view', role:'Frame the selected target', group:'Transform', lucide:'Scan', size:16},
  {name:'inspect', label:'Inspect', role:'Orbit the view without saving a camera', group:'Transform', lucide:'Orbit', size:16},
  {name:'play', label:'Play', role:'Start playback', group:'Playback', lucide:'Play', size:16},
  {name:'pause', label:'Pause', role:'Stop at the current time', group:'Playback', lucide:'Pause', size:16},
  {name:'skipBack', label:'Go to start', role:'Seek to the first frame', group:'Playback', lucide:'SkipBack', size:16},
  {name:'skipForward', label:'Go to end', role:'Seek to the final frame', group:'Playback', lucide:'SkipForward', size:16},
  {name:'undo', label:'Undo', role:'Restore the preceding scene edit', group:'Actions', lucide:'Undo2', size:16},
  {name:'redo', label:'Redo', role:'Reapply an undone scene edit', group:'Actions', lucide:'Redo2', size:16},
  {name:'history', label:'History', role:'Open saved revisions', group:'Actions', lucide:'History', size:16},
  {name:'dice', label:'Generate a variation', role:'Generate a candidate for review', group:'Actions', lucide:'Dice5', size:16},
  {name:'download', label:'Download', role:'Retrieve an available output file', group:'Actions', lucide:'Download', size:16},
  {name:'plus', label:'Increase / add', role:'Increment a value or add an item', group:'Actions', lucide:'Plus', size:12},
  {name:'minus', label:'Decrease / remove', role:'Decrement a value or remove an item', group:'Actions', lucide:'Minus', size:12},
  {name:'check', label:'Confirmed', role:'The named action or selection is complete', group:'State', lucide:'Check', size:14},
  {name:'eye', label:'Visible', role:'The object is included in the view', group:'State', lucide:'Eye', size:14},
  {name:'eyeoff', label:'Hidden', role:'The object is excluded from the view', group:'State', lucide:'EyeOff', size:14},
  {name:'lock', label:'Read-only', role:'The property cannot be edited here', group:'State', lucide:'LockKeyhole', size:14},
  {name:'alert', label:'Needs attention', role:'The named value or operation is invalid', group:'State', lucide:'TriangleAlert', size:14},
  {name:'unavailable', label:'Unavailable', role:'The named action is not available', group:'State', lucide:'CircleSlash', size:14},
  {name:'loader', label:'Working', role:'The named operation is in progress', group:'State', lucide:'LoaderCircle', size:14},
  {name:'clock', label:'Time', role:'Timing or ongoing animation', group:'State', lucide:'Clock', size:14},
  {name:'circle', label:'Preview', role:'An uncommitted preview; keep the state word', group:'State', lucide:'Circle', size:14},
  {name:'chevron', label:'Open', role:'Disclose the next level or continue a stated path', group:'Disclosure', lucide:'ChevronRight', size:14},
  {name:'down', label:'Expanded', role:'The next level is open', group:'Disclosure', lucide:'ChevronDown', size:14},
  {name:'option', label:'Option / Alt', role:'A modifier in a written keyboard shortcut', group:'Disclosure', lucide:'Option', size:12},
] as const;

export type UiIconName = typeof UI_ICON_CATALOG[number]['name'];
export type UiIconGroup = typeof UI_ICON_CATALOG[number]['group'];
export const UI_ICON_STROKE = 1.5;
export const UI_ICON_SIZES = {standard:16, dense:14, simple:12, prominent:20} as const;
