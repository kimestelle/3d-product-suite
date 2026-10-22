import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {clearCache} from '@chenglou/pretext';
import {mountContourText,paintContourText,unmountContourText,contourTextMoving} from './philosophyTextDom';

let reads=0,textWrites=0,fontReads=0;
let styleWrites:{property:string;value:string}[]=[];
class TestElement {
  nodeName:string;childNodes:TestElement[]=[];parent:TestElement|null=null;
  style:Record<string,string>;dataset:Record<string,string>={};className='';attributes=new Map<string,string>();
  value='';rect={left:300,top:100,width:240,height:72};
  constructor(name:string){
    this.nodeName=name.toUpperCase();
    this.style=new Proxy({} as Record<string,string>,{set(target,property:string,value:string){styleWrites.push({property,value});target[property]=value;return true;}});
  }
  get textContent():string{return this.childNodes.length?this.childNodes.map(node=>node.textContent).join(''):this.value;}
  set textContent(value:string){textWrites++;this.value=value;this.childNodes=[];}
  matches(selector:string){return selector.split(',').includes(this.nodeName.toLowerCase());}
  querySelectorAll(){return this.childNodes;}
  getBoundingClientRect(){reads++;return {...this.rect,right:this.rect.left+this.rect.width,bottom:this.rect.top+this.rect.height};}
  getAttribute(name:string){return this.attributes.get(name)??null;}
  setAttribute(name:string,value:string){this.attributes.set(name,value);}
  removeAttribute(name:string){this.attributes.delete(name);}
  replaceChildren(...nodes:TestElement[]){this.childNodes=nodes;this.value='';for(const node of nodes)node.parent=this;}
  append(node:TestElement){this.childNodes.push(node);node.parent=this;}
}
class TestCanvas {
  getContext(){return {font:'16px sans-serif',letterSpacing:'0px',measureText(text:string){
    fontReads++;
    const size=Number(this.font.match(/([\d.]+)px/)?.[1]??16),width=[...text].length*size/2;
    return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width};
  }};}
}
const text='A ground applied to a surface before painting.';
beforeEach(()=>{
  reads=textWrites=fontReads=0;styleWrites=[];
  vi.stubGlobal('OffscreenCanvas',TestCanvas);
  vi.stubGlobal('document',{documentElement:{lang:'en'},createElement:(name:string)=>new TestElement(name)});
  vi.stubGlobal('getComputedStyle',(element:TestElement)=>({fontStyle:'normal',fontWeight:'400',fontSize:element.nodeName==='H2'?'40px':'16px',fontFamily:'"Halyard Text"',lineHeight:element.nodeName==='H2'?'48px':'24px',letterSpacing:'0px'}));
  clearCache();
});
afterEach(()=>{clearCache();vi.unstubAllGlobals();});
const mount=(tag='p',value=text,width=240)=>{
  const element=new TestElement(tag),source=new TestElement('#text');source.textContent=value;element.append(source);
  element.rect.width=width;element.setAttribute('style','color: white');
  const block=mountContourText(element as unknown as HTMLElement,element.getBoundingClientRect() as DOMRect,new Map());
  return {element,source,block};
};
const options=(edge:number)=>({left:300,top:100,right:1000,laneLeft:100,side:'left' as const,
  query:()=>({left:edge,right:850})});
const x=(span:TestElement)=>Number(span.style.transform.match(/translateX\(([-\d.e+]+)px\)/)?.[1]);

describe('complete lines following the contour',()=>{
  it('keeps exact line nodes, source ranges, y positions and heights through contour changes and reversal',()=>{
    const {element,block}=mount();
    const spans=[...element.childNodes],ranges=spans.map(span=>span.dataset.range),rows=spans.map(span=>span.style.top);
    const height=element.style.height,blockHeight=block.height;
    const at=(edge:number)=>{
      expect(paintContourText(block,options(edge))).toBe(blockHeight);
      return spans.map(span=>span.style.transform);
    };
    const coldReads=reads,coldWrites=textWrites,coldFontReads=fontReads;
    styleWrites=[];
    const edges=[700,570,500,420,500,570,700];
    const forward=edges.map(at),reverse=[...edges].reverse().map(at).reverse();
    expect(reverse).toEqual(forward);
    expect(new Set(forward.map(value=>value.join('|'))).size).toBeGreaterThan(1);
    expect(element.childNodes).toEqual(spans);
    expect(spans.map(span=>span.dataset.range)).toEqual(ranges);
    expect(spans.map(span=>span.style.top)).toEqual(rows);
    expect(element.style.height).toBe(height);
    expect(element.textContent).toBe(text);
    expect(spans.every(span=>span.className==='shape-light-text-line')).toBe(true);
    expect(reads).toBe(coldReads);expect(textWrites).toBe(coldWrites);expect(fontReads).toBe(coldFontReads);
    expect(styleWrites.every(write=>write.property==='transform'&&write.value.startsWith('translateX('))).toBe(true);
    expect(contourTextMoving(block)).toBe(false);
    styleWrites=[];at(700);expect(styleWrites).toEqual([]);
  });

  it.each(['left','right'] as const)('keeps %s lines inside the explicit interior lane and outside hard contact',side=>{
    const {element,block}=mount();
    const frame={left:400,top:100,laneLeft:180,laneRight:900,right:1200,side,query:()=>({left:510,right:610})};
    paintContourText(block,frame);
    for(const [index,line] of block.leaves[0].lines.entries()){
      const left=frame.left+x(element.childNodes[index]);
      expect(left).toBeGreaterThanOrEqual(180);
      expect(left+line.source.width).toBeLessThanOrEqual(900);
      if(side==='left')expect(left+line.source.width).toBeLessThanOrEqual(510-24);
      else expect(left).toBeGreaterThanOrEqual(610+24);
    }
    expect(block.blockedLines).toBe(0);
  });

  it('accepts the legacy right bound and defaults laneLeft to the block anchor',()=>{
    const {element,block}=mount();
    paintContourText(block,{left:300,top:100,right:900,side:'right',query:()=>({left:400,right:500})});
    for(const [index,line] of block.leaves[0].lines.entries()){
      const left=300+x(element.childNodes[index]);
      expect(left).toBeGreaterThanOrEqual(524);
      expect(left+line.source.width).toBeLessThanOrEqual(900);
    }
  });

  it('reports a closed lane without throwing, dropping words or changing line geometry',()=>{
    const {element,block}=mount();
    const spans=[...element.childNodes],rows=spans.map(span=>span.style.top),height=element.style.height;
    expect(()=>paintContourText(block,{left:300,top:100,right:900,laneLeft:180,side:'left',query:()=>({left:190,right:850})})).not.toThrow();
    expect(block.blockedLines).toBe(spans.length);
    expect(element.childNodes).toEqual(spans);expect(element.textContent).toBe(text);
    expect(spans.map(span=>span.style.top)).toEqual(rows);expect(element.style.height).toBe(height);
    expect(spans.every(span=>300+x(span)===180)).toBe(true);
    paintContourText(block,{left:300,top:100,right:900,laneLeft:180,side:'left',query:()=>null});
    expect(block.blockedLines).toBe(0);
  });

  it('releases a flat edge continuously over a deterministic vertical shoulder, with exact reverse replay',()=>{
    const {element,block}=mount('p','ground');
    const query=(top:number,bottom:number)=>bottom<200||top>300?null:{left:300,right:700};
    const at=(top:number)=>{
      paintContourText(block,{left:300,top,right:900,laneLeft:100,side:'left',query});
      return x(element.childNodes[0]);
    };
    const positions=Array.from({length:66},(_,index)=>304+index);
    const forward=positions.map(at),reverse=[...positions].reverse().map(at).reverse();
    expect(reverse).toEqual(forward);
    expect(forward[0]).toBeLessThan(-60);expect(forward.at(-1)).toBe(0);
    for(let index=1;index<forward.length;index++){
      expect(forward[index]).toBeGreaterThanOrEqual(forward[index-1]);
      expect(forward[index]-forward[index-1]).toBeLessThan(2);
    }
    expect(new Set(forward).size).toBeGreaterThan(50);
    expect(contourTextMoving(block)).toBe(false);
  });

  it('retains explicit heading breaks and empty rows in the selectable source',()=>{
    for(const [tag,value,width] of [['h2','How we\nmake things.',340],['p','first\nsecond\n\nfinal',240]] as const){
      const {element,block}=mount(tag,value,width);
      const spans=[...element.childNodes],ranges=spans.map(span=>span.dataset.range),rows=spans.map(span=>span.style.top);
      paintContourText(block,options(700));paintContourText(block,options(420));
      expect(element.textContent).toBe(value);
      expect(element.childNodes).toEqual(spans);expect(spans.map(span=>span.dataset.range)).toEqual(ranges);
      expect(spans.map(span=>span.style.top)).toEqual(rows);
      expect(spans.every(span=>span.className==='shape-light-text-line')).toBe(true);
    }
  });

  it('uses the same positions with reduced motion and restores original React-owned nodes/styles',()=>{
    const {element,source,block}=mount();
    paintContourText(block,{...options(500),animate:true,now:20});
    const positions=element.childNodes.map(span=>span.style.transform);
    paintContourText(block,{...options(500),animate:false,now:2000});
    expect(element.childNodes.map(span=>span.style.transform)).toEqual(positions);
    expect(contourTextMoving(block)).toBe(false);
    unmountContourText(block);
    expect(element.childNodes).toEqual([source]);expect(element.childNodes[0]).toBe(source);
    expect(element.getAttribute('style')).toBe('color: white');expect(element.dataset.pretextLeaf).toBeUndefined();
    expect(element.textContent).toBe(text);
  });

  it('only creates new wraps after explicit teardown and width remeasurement',()=>{
    const {element,block}=mount();
    const oldRanges=element.childNodes.map(span=>span.dataset.range);
    unmountContourText(block);element.rect.width=120;
    const next=mountContourText(element as unknown as HTMLElement,element.getBoundingClientRect() as DOMRect,new Map());
    expect(element.childNodes.map(span=>span.dataset.range)).not.toEqual(oldRanges);
    expect(element.textContent).toBe(text);expect(next.leaves[0].lines.length).toBeGreaterThan(block.leaves[0].lines.length);
  });
});
