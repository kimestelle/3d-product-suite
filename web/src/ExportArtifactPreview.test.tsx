import React,{type ReactElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import ExportArtifactPreview,{exportReviewFiles,isReviewArtifactUrl,selectExportReview,type ExportArtifactPreviewProps} from './ExportArtifactPreview';
import type {ExportJob} from './exportModel';

const hooks=vi.hoisted(()=>({cursor:0,values:[] as any[],dependencies:[] as unknown[][],effects:[] as (()=>void)[],dirty:false}));
vi.mock('react',async original=>{
  const actual=await original<typeof import('react')>();
  return {...actual,useState(initial:unknown){const i=hooks.cursor++;if(!(i in hooks.values))hooks.values[i]=typeof initial==='function'?initial():initial;
    return [hooks.values[i],(update:any)=>{const value=typeof update==='function'?update(hooks.values[i]):update;if(!Object.is(value,hooks.values[i])){hooks.values[i]=value;hooks.dirty=true;}}];},
    useRef(initial:unknown){const i=hooks.cursor++;return hooks.values[i]??={current:initial};},
    useEffect(effect:()=>void,dependencies:unknown[]){const i=hooks.cursor++,previous=hooks.dependencies[i];if(!previous||dependencies.some((value,n)=>!Object.is(value,previous[n]))){hooks.dependencies[i]=dependencies;hooks.effects.push(effect);}},
  };
});
const png={name:'still.png',url:'/api/jobs/render-1/files/still.png',downloadName:'watch.png'};
const job:ExportJob={id:'render-1',kind:'still',state:'succeeded',format:'png',filename:'Watch proof',width:540,height:960,frame:1,samples:32,sourceDigest:'saved-source',completedFrames:1,totalFrames:1,artifacts:[png]};
function render(props:ExportArtifactPreviewProps){let tree:ReactElement<any>;do{hooks.cursor=0;hooks.effects=[];hooks.dirty=false;tree=ExportArtifactPreview(props);for(const effect of hooks.effects)effect();}while(hooks.dirty);return tree;}
function nodes(tree:ReactNode):ReactElement<any>[]{return React.Children.toArray(tree).flatMap(node=>React.isValidElement<any>(node)?[node,...nodes((node as ReactElement<any>).props.children)]:[]);}
const find=(tree:ReactNode,type:any)=>nodes(tree).find(node=>node.type===type)!;
beforeEach(()=>{hooks.cursor=0;hooks.values=[];hooks.dependencies=[];hooks.effects=[];hooks.dirty=false;});

describe('rendered export selection',()=>{
  it('automatically opens completion once but respects a dismissed review through polling',()=>{
    const source={};let review=selectExportReview(null,{...job,state:'queued',artifacts:[]},source,'still');
    expect(review?.visible).toBe(false);review=selectExportReview(review,job,source,'still');expect(review?.visible).toBe(true);
    review={...review!,visible:false};review=selectExportReview(review,{...job},source,'still');expect(review?.visible).toBe(false);
    expect(selectExportReview(review,job,source,'still',true)?.visible).toBe(true);
    expect(selectExportReview(review,null,source,'still')).toBeNull();
  });
  it('keeps failed/running files out and only embeds verified local artifact routes',()=>{
    expect(exportReviewFiles({...job,state:'running'})).toEqual([]);
    for(const url of ['https://outside.test/still.png','javascript:alert(1)','/api/jobs/render-1/files/../../secret','/api/jobs/render-1/files/still.png?download=1'])expect(isReviewArtifactUrl(url)).toBe(false);
    expect(exportReviewFiles({...job,artifacts:[{...png,url:'https://outside.test/still.png'}]})).toEqual([]);
    expect(exportReviewFiles(job)[0]).toMatchObject({kind:'image',artifact:png});
  });
  it('retains both actual comparison sources and treats sequence archives honestly',()=>{
    const pair={...job,paired:true,primaryArtifact:'pair.zip',artifacts:[{name:'a/still.png',url:'/api/jobs/a/files/still.png'},{name:'b/still.png',url:'/api/jobs/b/files/still.png'}]};
    expect(exportReviewFiles(pair).map(value=>value.label)).toEqual(['A · Rendered still','B · Rendered still']);
    const sequence={...job,kind:'reel' as const,format:'png-sequence' as const,artifacts:[{name:'frames.zip',url:'/api/jobs/render-1/files/frames.zip'}]};
    expect(exportReviewFiles(sequence)[0].kind).toBe('archive');
    const html=renderToStaticMarkup(render({job:sequence,currentDigest:'saved-source',onBack:vi.fn()}));
    expect(html).toContain('packaged as an archive');expect(html).not.toContain('<video');expect(html).not.toContain('<img');
  });
});

describe('actual artifact presentation',()=>{
  it('shows the actual PNG/profile/revision and downloadable file with no editable renderer replica',()=>{
    const onBack=vi.fn(),tree=render({job,currentDigest:'newer-source',onBack}),html=renderToStaticMarkup(tree);
    expect(html).toContain('src="/api/jobs/render-1/files/still.png"');expect(html).toContain('Cycles render · 540 × 960 · Frame 1 · 32 samples');
    expect(html).toContain('Earlier scene revision');expect(html).toContain('download="watch.png"');expect(html).not.toContain('<canvas');
    find(tree,'img').props.onLoad();expect(renderToStaticMarkup(render({job,currentDigest:'newer-source',onBack}))).not.toContain('Opening rendered image');
    tree.props.onKeyDown({key:'Escape',preventDefault:vi.fn(),stopPropagation:vi.fn()});expect(onBack).toHaveBeenCalledOnce();
  });
  it('does not let a late previous A image failure hide the current B image',()=>{
    const pair={...job,paired:true,artifacts:[{name:'a/still.png',url:'/api/jobs/a/files/still.png'},{name:'b/still.png',url:'/api/jobs/b/files/still.png'}]},props={job:pair,currentDigest:'saved-source',onBack:vi.fn()};
    let tree=render(props);const stale=find(tree,'img');find(tree,'select').props.onChange({target:{value:'1'}});tree=render(props);
    stale.props.onError();tree=render(props);expect(find(tree,'img').props.src).toBe('/api/jobs/b/files/still.png');
    expect(renderToStaticMarkup(tree)).not.toContain('could not be opened');
  });
  it('exposes native video controls and retains actual contact sheet/download when a codec fails',()=>{
    const video={...job,kind:'reel' as const,format:'prores' as const,artifacts:[{name:'film.mov',url:'/api/jobs/render-1/files/film.mov'},{name:'contact-sheet.png',url:'/api/jobs/render-1/files/contact-sheet.png'}]},props={job:video,currentDigest:'saved-source',onBack:vi.fn()};
    let tree=render(props),element=find(tree,'video');expect(element.props.controls).toBe(true);expect(element.props.autoPlay).toBeUndefined();
    element.props.onError();tree=render(props);const html=renderToStaticMarkup(tree);expect(html).toContain('cannot play the rendered film');
    expect(html).toContain('alt="Rendered contact sheet"');expect(html).toContain('/api/jobs/render-1/files/film.mov?download=1');
  });
});
