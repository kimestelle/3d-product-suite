import {describe,it,expect} from 'vitest';
import {defaultLayers,editorDestinationUrl,editorModeUrl,groups,layers,readEditorDestination,readEditorMode,shortcutDestination} from './navigation';
const key={altKey:true,metaKey:false,ctrlKey:false,shiftKey:false,code:'Digit1'};
describe('editor shortcuts',()=>{
 it('uses uniform Option digits for the four steps in displayed order',()=>{
  expect(groups.map(group=>group.id)).toEqual(['product','material','world','renders']);
  groups.forEach(({id},index)=>expect(shortcutDestination({...key,code:`Digit${index+1}`},'product')).toEqual({group:id}));
 });
 it('addresses the layers inside each step with Option 5 onward',()=>{
  expect(layers.product).toEqual(['Model']);
  expect(layers.material).toEqual(['Materials','Decals']);
  expect(layers.renders).toEqual(['Framing','Animation','Sequence','Output']);
  for(const {id} of groups) {
   layers[id].forEach((layer,index)=>expect(shortcutDestination({...key,code:`Digit${index+5}`},id)).toEqual({layer}));
   expect(shortcutDestination({...key,code:'Digit9'},id)).toBeNull();
  }
 });
 it('limits Still shortcuts to its visible Film sections without changing Video mapping',()=>{
  expect(shortcutDestination({...key,code:'Digit5'},'renders','still')).toEqual({layer:'Framing'});
  expect(shortcutDestination({...key,code:'Digit6'},'renders','still')).toEqual({layer:'Output'});
  for(const digit of [7,8,9])expect(shortcutDestination({...key,code:`Digit${digit}`},'renders','still')).toBeNull();
  expect(shortcutDestination({...key,code:'Digit6'},'renders','video')).toEqual({layer:'Animation'});
  expect(shortcutDestination({...key,code:'Digit6'},'material','still')).toEqual({layer:'Decals'});
  groups.forEach(({id},index)=>expect(shortcutDestination({...key,code:`Digit${index+1}`},'renders','still')).toEqual({group:id}));
 });
 it('leaves browser and modified shortcuts alone',()=>{for(const patch of [{altKey:false},{metaKey:true},{ctrlKey:true},{shiftKey:true},{repeat:true},{code:'KeyA'}])expect(shortcutDestination({...key,...patch},'product')).toBeNull()});
});

describe('editor window URLs',()=>{
 const destinations=groups.flatMap(({id:group})=>layers[group].map(layer=>({group,layer})));
 it('derives every default from its first visible layer',()=>{
  for(const {id} of groups)expect(defaultLayers[id]).toBe(layers[id][0]);
  expect(readEditorDestination('/')).toEqual({group:'product',layer:'Model'});
 });
 it.each(destinations)('round trips $group / $layer',destination=>{
  const url=editorDestinationUrl('/',destination);
  expect(readEditorDestination(url)).toEqual(destination);
  const params=new URL(url,'https://gesso.test').searchParams;
  expect(params.get('step')).toBe(destination.group==='renders'?'film':destination.group);
  expect(params.get('layer')).toBe(destination.layer.toLowerCase());
 });
 it.each(groups)('defaults missing or mismatched layers for $label',({id})=>{
  for(const layer of ['', '&layer=unknown', '&layer='+layers[id==='product'?'world':'product'][0].toLowerCase()]) {
   expect(readEditorDestination('/?step='+id+layer)).toEqual({group:id,layer:defaultLayers[id]});
  }
 });
 it.each(destinations)('infers $group from the unique $layer layer',destination=>{
  expect(readEditorDestination('/?layer='+destination.layer.toLowerCase())).toEqual(destination);
 });
 it('rejects invalid explicit steps without inferring another group',()=>{
  for(const step of ['unknown','', 'scene'])expect(readEditorDestination('/?step='+step+'&layer=lights')).toEqual({group:'product',layer:'Model'});
  for(const layer of ['unknown','constructor','__proto__']) {
   expect(readEditorDestination('/?layer='+layer)).toEqual({group:'product',layer:'Model'});
   expect(readEditorDestination('/?step=film&layer='+layer)).toEqual({group:'renders',layer:'Framing'});
  }
 });
 it('accepts case-insensitive step/layer names and legacy renders links',()=>{
  expect(readEditorDestination('/?step=WORLD&layer=LiGhTs')).toEqual({group:'world',layer:'Lights'});
  expect(readEditorDestination('/?step=%20Film%20&layer=%20TIMING%20')).toEqual({group:'renders',layer:'Output'});
  expect(readEditorDestination('/?step=renders&layer=shots')).toEqual({group:'renders',layer:'Sequence'});
  expect(editorDestinationUrl('/?step=renders&layer=shots',readEditorDestination('/?step=renders&layer=shots'))).toBe('/?step=film&layer=sequence');
 });
 it.each(['placement','animation'])('routes old Product %s links to Film Animation',layer=>{
  for(const input of ['/?step=product&layer='+layer,'/?layer='+layer,'/?step=PRODUCT&layer=%20'+layer.toUpperCase()+'%20']) {
   const destination=readEditorDestination(input);
   expect(destination).toEqual({group:'renders',layer:'Animation'});
   const canonical=new URL(editorDestinationUrl(input,destination),'https://gesso.test');
   expect(canonical.searchParams.get('step')).toBe('film');
   expect(canonical.searchParams.get('layer')).toBe('animation');
  }
  const oldUrl='/studio?campaign=lamp&step=product&layer='+layer+'&tag=one&tag=two#part';
  expect(editorDestinationUrl(oldUrl,readEditorDestination(oldUrl))).toBe('/studio?campaign=lamp&step=film&layer=animation&tag=one&tag=two#part');
  expect(readEditorDestination('/?step=world&layer='+layer)).toEqual({group:'world',layer:'Environment'});
  expect(readEditorDestination('/?step=unknown&layer='+layer)).toEqual({group:'product',layer:'Model'});
 });
 it('routes legacy Material and Decal links out of Product',()=>{
  for(const layer of ['Materials','Decals']) {
   const url='/?step=product&layer='+layer.toLowerCase();
   const destination=readEditorDestination(url);
   expect(destination).toEqual({group:'material',layer});
   expect(editorDestinationUrl(url,destination)).toBe('/?step=material&layer='+layer.toLowerCase());
  }
 });
 it('moves Camera links to Film Framing and preserves the transitional Motion alias',()=>{
  for(const layer of ['lens','focus','path']) {
   for(const input of ['/?step=camera&layer='+layer,'/?layer='+layer])expect(readEditorDestination(input)).toEqual({group:'renders',layer:'Framing'});
  }
  expect(readEditorDestination('/?step=camera')).toEqual({group:'renders',layer:'Framing'});
  expect(readEditorDestination('/?step=motion&layer=animation')).toEqual({group:'renders',layer:'Animation'});
  expect(readEditorDestination('/?layer=shots')).toEqual({group:'renders',layer:'Sequence'});
  expect(readEditorDestination('/?layer=timing')).toEqual({group:'renders',layer:'Output'});
 });
 it('preserves the pathname, unrelated repeated parameters, and hash while collapsing window parameters',()=>{
  const input=new URL('https://gesso.test/studio/view?campaign=lamp&step=product&step=world&layer=model&layer=props&tag=one&tag=two#inspect');
  const original=input.href;
  const result=editorDestinationUrl(input,{group:'renders',layer:'Framing'});
  expect(result).toBe('/studio/view?campaign=lamp&step=film&layer=framing&tag=one&tag=two#inspect');
  expect(input.href).toBe(original);
  expect(readEditorDestination(input)).toEqual({group:'product',layer:'Model'});
 });
 it('canonicalizes a mismatched destination and supports relative query strings',()=>{
  expect(editorDestinationUrl('?campaign=lamp#part',{group:'world',layer:'Model'})).toBe('/?campaign=lamp&step=world&layer=environment#part');
  expect(editorDestinationUrl('/',{group:'renders',layer:'FOCUS'})).toBe('/?step=film&layer=framing');
  expect(editorDestinationUrl('/',{group:'product',layer:'Placement'})).toBe('/?step=film&layer=animation');
 });
});

describe('Still / Video URL mode',()=>{
 it('defaults missing and invalid modes to Video and normalizes Still',()=>{
  for(const url of ['/','/?mode=video','/?mode=unknown','/?mode='])expect(readEditorMode(url)).toBe('video');
  expect(readEditorMode('/?mode=%20STILL%20')).toBe('still');
 });
 it('preserves Still across group changes without changing other query state',()=>{
  expect(editorDestinationUrl('/studio?mode=still&campaign=lamp#part',{group:'material',layer:'Materials'})).toBe('/studio?mode=still&campaign=lamp&step=material&layer=materials#part');
 });
 it('changes only mode plus canonical window parameters, retaining repeated unrelated values',()=>{
  const original='/studio?step=film&layer=animation&tag=one&tag=two#key';
  const still=editorModeUrl(original,'still');
  expect(still).toBe('/studio?step=film&layer=animation&tag=one&tag=two&mode=still#key');
  expect(readEditorDestination(still)).toEqual(readEditorDestination(original));
  expect(editorModeUrl(still,'video')).toBe(original);
 });
 it('canonicalizes legacy links and duplicate mode parameters without mutating the input',()=>{
  const input=new URL('https://gesso.test/?step=camera&layer=path&mode=STILL&mode=video');
  const original=input.href;
  expect(editorModeUrl(input,'still')).toBe('/?step=film&layer=framing&mode=still');
  expect(input.href).toBe(original);
  expect(editorModeUrl('/?step=product&layer=model&mode=unknown','video')).toBe('/?step=product&layer=model');
 });
});
