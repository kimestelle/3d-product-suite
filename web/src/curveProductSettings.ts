import type {ComparisonMethod} from './curveComparison';

export type ProductViewMode='solid'|'translucent'|'wireframe';
export type ProductViewSettings={mode:ProductViewMode;opacity:number;edges:number;backEdges:boolean};
export type ProductSettingsByMethod=Record<ComparisonMethod,ProductViewSettings>;
export const DEFAULT_PRODUCT_SETTINGS:Readonly<ProductViewSettings>=Object.freeze({mode:'solid',opacity:.18,edges:.12,backEdges:false});
const methods:ComparisonMethod[]=['current','sdf','radial'];
const codes=['c','s','r'];
const modes:ProductViewMode[]=['solid','translucent','wireframe'];
const unit=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(1,value)):fallback;
export function normalizeProductSettings(value:unknown):ProductViewSettings {
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value as Partial<ProductViewSettings>:{};
  return {mode:modes.includes(source.mode as ProductViewMode)?source.mode!:DEFAULT_PRODUCT_SETTINGS.mode,
    opacity:unit(source.opacity,DEFAULT_PRODUCT_SETTINGS.opacity),edges:unit(source.edges,DEFAULT_PRODUCT_SETTINGS.edges),
    backEdges:typeof source.backEdges==='boolean'?source.backEdges:false};
}
export function readProductSettings(value:string|null,legacySurface:string|null=null):ProductSettingsByMethod {
  const result=Object.fromEntries(methods.map(method=>[method,{...DEFAULT_PRODUCT_SETTINGS}])) as ProductSettingsByMethod;
  if(value&&value.length<=512)for(const part of value.split(';')) {
    const [code,body]=part.split(':'),index=codes.indexOf(code),fields=body?.split(',');
    if(index<0||fields?.length!==4)continue;
    const [mode,opacity,edges,backEdges]=fields;
    result[methods[index]]=normalizeProductSettings({mode,opacity:opacity.trim()?Number(opacity):NaN,edges:edges.trim()?Number(edges):NaN,backEdges:backEdges==='1'});
  }
  // The earlier image-overlay sliders have no physical equivalent. Retain the
  // selected view only, never reinterpret cell size as mesh geometry.
  else if(legacySurface&&legacySurface.length<=512)for(const part of legacySurface.split(';')) {
    const [code,body]=part.split(':'),index=codes.indexOf(code),mode=body?.split(',')[0];
    if(index>=0)result[methods[index]].mode=mode==='mesh'?'wireframe':mode==='translucent'?'translucent':'solid';
  }
  return result;
}
export function serializeProductSettings(value:ProductSettingsByMethod):string {
  const items=methods.map(method=>normalizeProductSettings(value[method]));
  if(items.every(item=>Object.keys(DEFAULT_PRODUCT_SETTINGS).every(key=>item[key as keyof ProductViewSettings]===DEFAULT_PRODUCT_SETTINGS[key as keyof ProductViewSettings])))return '';
  return items.map((item,index)=>`${codes[index]}:${item.mode},${Number(item.opacity.toFixed(6))},${Number(item.edges.toFixed(6))},${item.backEdges?'1':'0'}`).join(';');
}
export function updateProductSettings(value:ProductSettingsByMethod,method:ComparisonMethod,patch:Partial<ProductViewSettings>):ProductSettingsByMethod {
  return {...value,[method]:normalizeProductSettings({...value[method],...patch})};
}
