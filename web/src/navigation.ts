export type EditorGroup = 'product'|'world'|'renders';
export type EditorMode = 'still'|'video';
export const groups: {id:EditorGroup;label:string}[] = [{id:'product',label:'Product'},{id:'world',label:'Stage'},{id:'renders',label:'Film'}];
export const layers: Record<EditorGroup,string[]> = {product:['Model','Materials','Decals'],world:['Environment','Props','Lights'],renders:['Framing','Animation','Sequence','Output']};
export type EditorDestination = {group:EditorGroup;layer:string};
export const defaultLayers = Object.fromEntries(groups.map(({id})=>[id,layers[id][0]])) as Record<EditorGroup,string>;

const normalized = (value:string|null) => value?.trim().toLowerCase();
const asUrl = (input:URL|string) => new URL(String(input),'http://gesso.local');
const filmAliases = new Map([['lens','Framing'],['focus','Framing'],['path','Framing'],['shots','Sequence'],['timing','Output']]);

// Keep established world/film URLs while accepting visible and legacy step names.
export function readEditorDestination(input:URL|string):EditorDestination {
  const url=asUrl(input), step=normalized(url.searchParams.get('step')), layerName=normalized(url.searchParams.get('layer'));
  let group:EditorGroup='product';
  if(url.searchParams.has('step')) {
    const id=step==='film'||step==='camera'||step==='motion'?'renders':step==='stage'?'world':step==='material'?'product':step;
    const match=groups.find(group=>group.id===id);
    if(!match)return {group,layer:defaultLayers[group]};
    group=match.id;
    // Material links retain their former default and now open within Product.
    if(step==='material')return {group,layer:layerName==='decals'?'Decals':'Materials'};
    // The old Camera step always opens its replacement, Framing.
    if(step==='camera')return {group,layer:'Framing'};
    if(step==='motion')return {group,layer:'Animation'};
  } else if(layerName) {
    if(layerName==='placement')return {group:'renders',layer:'Animation'};
    const alias=filmAliases.get(layerName);
    if(alias)return {group:'renders',layer:alias};
    const matches=groups.filter(({id})=>layers[id].some(layer=>layer.toLowerCase()===layerName));
    if(matches.length===1)group=matches[0].id;
  }
  // Static placement and animation remain Film work, including old Product links.
  if((group==='product'||group==='renders')&&(layerName==='placement'||layerName==='animation'))return {group:'renders',layer:'Animation'};
  const alias=layerName?filmAliases.get(layerName):undefined;
  if(group==='renders'&&alias)return {group,layer:alias};
  const layer=layers[group].find(layer=>layer.toLowerCase()===layerName)??defaultLayers[group];
  return {group,layer};
}

export function readEditorMode(input:URL|string):EditorMode {
  return normalized(asUrl(input).searchParams.get('mode'))==='still'?'still':'video';
}

export function editorDestinationUrl(input:URL|string,destination:EditorDestination,mode:EditorMode=readEditorMode(input)):string {
  const url=asUrl(input);
  url.searchParams.set('step',destination.group==='renders'?'film':destination.group);
  url.searchParams.set('layer',destination.layer.toLowerCase());
  const canonical=readEditorDestination(url);
  url.searchParams.set('step',canonical.group==='renders'?'film':canonical.group);
  url.searchParams.set('layer',canonical.layer.toLowerCase());
  // Video is the default; omit it rather than adding noise to every shared URL.
  if(mode==='still')url.searchParams.set('mode','still');
  else url.searchParams.delete('mode');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function editorModeUrl(input:URL|string,mode:EditorMode):string {
  return editorDestinationUrl(input,readEditorDestination(input),mode);
}

// Physical digit keys keep Option shortcuts stable on macOS keyboard layouts.
export function shortcutDestination(event: {altKey:boolean;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;code:string;repeat?:boolean}, group:EditorGroup, mode:EditorMode='video'): {group?:EditorGroup;layer?:string}|null {
  if(!event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.repeat)return null;
  const digit = /^Digit([1-9])$/.exec(event.code);if(!digit)return null;
  const n=Number(digit[1]);if(n<=groups.length)return {group:groups[n-1].id};
  // Keep layer shortcuts at 5 onward; the former fourth category key is unused.
  if(n<5)return null;
  const visibleLayers=group==='renders'&&mode==='still'?['Framing','Output']:layers[group];
  const layer=visibleLayers[n-5];return layer?{layer}:null;
}
