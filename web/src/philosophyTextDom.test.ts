import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {clearCache} from '@chenglou/pretext';
import {mountContourText,paintContourText,unmountContourText,contourTextMoving} from './philosophyTextDom';

let reads=0,writes=0;
class TestElement {
  nodeName:string;childNodes:TestElement[]=[];parent:TestElement|null=null;
  style:Record<string,string>={};dataset:Record<string,string>={};className='';attributes=new Map<string,string>();
  value='';
  constructor(name:string){this.nodeName=name.toUpperCase();}
  get textContent():string{return this.childNodes.length?this.childNodes.map(node=>node.textContent).join(''):this.value;}
  set textContent(value:string){writes++;this.value=value;this.childNodes=[];}
  matches(selector:string){return selector.split(',').includes(this.nodeName.toLowerCase());}
  querySelectorAll(){return this.childNodes;}
  getBoundingClientRect(){reads++;return {left:40,top:100,width:360,height:72,right:400,bottom:172};}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  removeAttribute(name:string){this.attributes.delete(name);}
  replaceChildren(...nodes:TestElement[]){this.childNodes=nodes;this.value='';for(const node of nodes)node.parent=this;}
  append(node:TestElement){this.childNodes.push(node);node.parent=this;}
  remove(){if(this.parent)this.parent.childNodes=this.parent.childNodes.filter(node=>node!==this);this.parent=null;}
}
class TestCanvas {
  getContext(){return {font:'16px sans-serif',letterSpacing:'0px',measureText(text:string){
    const size=Number(this.font.match(/([\d.]+)px/)?.[1]??16),width=[...text].length*size/2;
    return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width};
  }};}
}
const text='A ground applied to a surface before painting.';
beforeEach(()=>{
  reads=writes=0;
  vi.stubGlobal('OffscreenCanvas',TestCanvas);
  vi.stubGlobal('document',{documentElement:{lang:'en'},createElement:(name:string)=>new TestElement(name)});
  vi.stubGlobal('getComputedStyle',(element:TestElement)=>({fontStyle:'normal',fontWeight:'400',fontSize:element.nodeName==='H2'?'40px':'16px',fontFamily:'"Halyard Text"',lineHeight:element.nodeName==='H2'?'48px':'24px',letterSpacing:'0px'}));
  clearCache();
});
afterEach(()=>{clearCache();vi.unstubAllGlobals();});
const mount=(tag='p',value=text)=>{
  const element=new TestElement(tag),source=new TestElement('#text');source.textContent=value;element.append(source);
  element.setAttribute('style','color: white');
  const block=mountContourText(element as unknown as HTMLElement,element.getBoundingClientRect() as DOMRect,new Map());
  return {element,source,block};
};
const options=(width:number,now:number,animate=true)=>({left:40,top:100,right:500,side:'left' as const,
  query:()=>({left:40+24+width,right:500}),now,animate});

describe('source-preserving DOM reflow',()=>{
  it('keeps the same selectable word nodes through wrapping and reversal, with no warm layout reads or text rewrites',()=>{
    const {element,block}=mount();
    paintContourText(block,options(340,0,false));
    const spans=[...element.childNodes],initial=spans.map(span=>span.style.transform);
    const coldReads=reads,coldWrites=writes;
    paintContourText(block,options(160,20));
    expect(contourTextMoving(block)).toBe(true);
    paintContourText(block,options(160,100));
    paintContourText(block,options(340,100));
    paintContourText(block,options(340,280));
    expect(element.childNodes).toEqual(spans);
    expect(element.childNodes.every((node,i)=>node===spans[i])).toBe(true);
    expect(element.textContent).toBe(text);
    expect(spans.map(span=>span.style.transform)).toEqual(initial);
    expect(contourTextMoving(block)).toBe(false);
    expect(reads).toBe(coldReads);
    expect(writes).toBe(coldWrites);
  });

  it('settles without animation and restores the original React-owned nodes and inline styles on cleanup',()=>{
    const {element,source,block}=mount();
    paintContourText(block,options(340,0,false));
    paintContourText(block,options(160,20));
    expect(contourTextMoving(block)).toBe(true);
    paintContourText(block,options(160,40,false));
    expect(contourTextMoving(block)).toBe(false);
    unmountContourText(block);
    expect(element.childNodes).toEqual([source]);
    expect(element.childNodes[0]).toBe(source);
    expect(element.getAttribute('style')).toBe('color: white');
    expect(element.dataset.pretextLeaf).toBeUndefined();
    expect(element.textContent).toBe(text);
  });

  it('keeps H2 words whole and source spans stable through narrow bands, including curly apostrophes',()=>{
    const heading='Keep what’s been decided.';
    const {element,block}=mount('h2',heading);
    expect(block.leaves[0].measure.preserveWords).toBe(true);
    const at=(width:number,now:number)=>({...options(width,now),
      query:(top:number)=>top<250?{left:40+24+width,right:500}:null});
    paintContourText(block,{...at(320,0),animate:false});
    const spans=[...element.childNodes];
    paintContourText(block,at(120,20));
    paintContourText(block,at(120,200));
    expect(element.childNodes).toEqual(spans);
    expect(spans.every(span=>span.className==='shape-light-text-token')).toBe(true);
    expect(spans.map(span=>span.textContent)).toEqual(['Keep ','what’s ','been ','decided.']);
    expect(element.textContent).toBe(heading);
    paintContourText(block,at(320,240));
    paintContourText(block,at(320,420));
    expect(element.childNodes.every((node,i)=>node===spans[i])).toBe(true);
    expect(element.textContent).toBe(heading);
  });

  it('retains explicit heading breaks in the real source text while moving the same word spans',()=>{
    const heading='How we\nmake things.';
    const {element,block}=mount('h2',heading);
    const at=(width:number,now:number)=>({...options(width,now),
      query:(top:number)=>top<250?{left:40+24+width,right:500}:null});
    paintContourText(block,{...at(320,0),animate:false});
    const spans=[...element.childNodes];
    paintContourText(block,at(160,20));
    paintContourText(block,at(160,200));
    expect(element.childNodes).toEqual(spans);
    expect(element.textContent).toBe(heading);
    expect(spans.filter(span=>span.textContent==='\n')).toHaveLength(1);
    expect(spans.every(span=>span.className==='shape-light-text-token')).toBe(true);
  });
});
