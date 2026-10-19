import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {clearCache,prepareWithSegments} from '@chenglou/pretext';
import {layoutContourText,type LineFlowLeaf} from './philosophyLineLayout';
import {prepareTextTokens,placeTextTokens,createTokenMotion,updateTokenMotion,constrainTokenMotion,TEXT_REFLOW_DURATION} from './philosophyTextMotion';

let measurements=0;
class TestCanvas {
  getContext(){return {font:'16px sans-serif',letterSpacing:'0px',measureText(text:string){
    measurements++;
    const size=Number(this.font.match(/([\d.]+)px/)?.[1]??16),width=[...text].length*size/2;
    return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width};
  }};}
}
beforeAll(()=>vi.stubGlobal('OffscreenCanvas',TestCanvas));
beforeEach(()=>{clearCache();measurements=0;});
afterAll(()=>{clearCache();vi.unstubAllGlobals();});
const position=(left:number,top:number,line='0:0')=>({left,top,line});
const setup=(text:string,letterSpacing=0)=>{
  const prepared=prepareWithSegments(text,'400 16px "Halyard Text"',{whiteSpace:'pre-wrap',letterSpacing});
  const leaf:LineFlowLeaf={prepared,lineHeight:24,top:0,left:0,width:360,naturalHeight:24};
  return {leaf,tokens:prepareTextTokens(prepared,letterSpacing)!};
};
const layout=(leaf:LineFlowLeaf,width:number)=>layoutContourText([leaf],{
  left:40,top:0,right:500,side:'left',query:top=>top<150?{left:40+24+width,right:500}:null,
});

describe('stable source words',()=>{
  it('conserves words, punctuation, spaces and explicit breaks in source order',()=>{
    const text='How we\nmake things.\n\nA  new label.';
    const {leaf,tokens}=setup(text);
    expect(tokens.map(token=>token.text).join('')).toBe(text);
    const result=layout(leaf,180),positions=placeTextTokens(tokens,result.lines)!;
    expect(positions).not.toBeNull();
    expect(positions).toHaveLength(tokens.length);
    expect(tokens.map(token=>token.key)).toEqual([...new Set(tokens.map(token=>token.key))]);
    expect(positions[tokens.findIndex(token=>token.text==='make ')]?.top).toBe(24);
    expect(positions[tokens.findIndex(token=>token.text==='A  ')]?.top).toBe(72);
  });

  it('retains token identity through narrower lanes and exact reverse replay without measurements',()=>{
    const {leaf,tokens}=setup('A ground applied to a surface before painting.');
    const keys=tokens.map(token=>token.key),count=measurements;
    const widths=[320,260,200,160,200,260,320];
    const frames=widths.map(width=>placeTextTokens(tokens,layout(leaf,width).lines));
    expect(frames.every(Boolean)).toBe(true);
    expect(frames[0]).toEqual(frames.at(-1));
    expect(frames[1]).toEqual(frames.at(-2));
    expect(new Set(frames.map(frame=>JSON.stringify(frame))).size).toBeGreaterThan(2);
    expect(tokens.map(token=>token.key)).toEqual(keys);
    expect(measurements).toBe(count);
    for(const width of widths){
      const result=layout(leaf,width),positions=placeTextTokens(tokens,result.lines)!;
      for(let i=0;i<tokens.length;i++){
        const line=result.lines.find(line=>line.top===positions[i].top)!;
        expect(positions[i].left+tokens[i].width).toBeLessThanOrEqual(line.left+line.width+.001);
      }
    }
  });

  it('uses Pretext segment advances plus authored tracking, preserving Halyard word spacing',()=>{
    const {leaf,tokens}=setup('A B C',-.5),result=layout(leaf,320);
    const positions=placeTextTokens(tokens,result.lines)!;
    expect(positions.map(item=>item.left)).toEqual([0,15,30]);
    expect(tokens.map(token=>token.width)).toEqual([7.5,7.5,7.5]);
  });

  it('keeps emergency grapheme wrapping and complex script shaping on the complete-line path',()=>{
    const {leaf,tokens}=setup('one uninterruptedmaterialmapping two.');
    const result=layout({...leaf,width:40},40);
    expect(placeTextTokens(tokens,result.lines)).toBeNull();
    expect(result.lines.map(line=>line.text+line.separator).join('')).toBe('one uninterruptedmaterialmapping two.');
    expect(prepareTextTokens(prepareWithSegments('مرحبا بالعالم','16px sans-serif'),0)).toBeNull();
  });
});

describe('interruptible reflow motion',()=>{
  it('only eases reflow: ordinary contour motion follows directly with no trailing playhead',()=>{
    const motion=createTokenMotion(position(10,0));
    expect(updateTokenMotion(motion,position(30,0),5,true)).toEqual(position(30,0));
    expect(updateTokenMotion(motion,position(50,0),10,true)).toEqual(position(50,0));
    expect(motion.active).toBe(false);
    expect(updateTokenMotion(motion,position(60,24,'2:0'),20,true)).toEqual(position(50,0,'2:0'));
    expect(motion.active).toBe(true);
    const middle=updateTokenMotion(motion,position(70,24,'2:0'),20+TEXT_REFLOW_DURATION/2,true);
    expect(middle.left).toBe(68.75);
    expect(middle.top).toBe(21);
    expect(updateTokenMotion(motion,position(70,24,'2:0'),20+TEXT_REFLOW_DURATION,true)).toEqual(position(70,24,'2:0'));
    expect(motion.active).toBe(false);
  });

  it('eases a discrete horizontal lane release when a flat edge leaves the line band',()=>{
    const motion=createTokenMotion(position(180,0)),target=position(0,0);
    expect(updateTokenMotion(motion,target,0,true)).toEqual(position(180,0));
    expect(motion.active).toBe(true);
    expect(updateTokenMotion(motion,target,90,true).left).toBe(22.5);
    expect(updateTokenMotion(motion,target,180,true)).toEqual(target);
    expect(motion.active).toBe(false);
  });

  it('reverses a wrap from the last displayed point, with no stale endpoint jump',()=>{
    const original=position(120,0),wrapped=position(0,24,'3:0');
    const motion=createTokenMotion(original);
    updateTokenMotion(motion,wrapped,0,true);
    const halfway=updateTokenMotion(motion,wrapped,90,true);
    const reversed=updateTokenMotion(motion,original,90,true);
    expect(reversed.left).toBe(halfway.left);
    expect(reversed.top).toBe(halfway.top);
    expect(updateTokenMotion(motion,original,270,true)).toEqual(original);
    expect(motion.active).toBe(false);
  });

  it('settles exactly and clears in-flight offsets when animation is disabled',()=>{
    const motion=createTokenMotion(position(80,0));
    const target=position(0,24,'2:0');
    updateTokenMotion(motion,target,0,true);
    expect(updateTokenMotion(motion,target,40,false)).toEqual(target);
    expect(motion.active).toBe(false);
    expect(motion.offsetX).toBe(0);
    expect(motion.offsetY).toBe(0);
  });

  it('keeps a moving word outside the real contour and inside page padding',()=>{
    const motion=createTokenMotion(position(180,0));
    updateTokenMotion(motion,position(0,24,'3:0'),0,true);
    const options={left:40,top:100,right:500,minimumLeft:0,lineHeight:24,side:'left' as const,
      query:()=>({left:200,right:400})};
    const shown=constrainTokenMotion(motion,64,options);
    expect(40+shown.left+64).toBe(200-24);
    expect(shown.left).toBeGreaterThanOrEqual(0);
    const rightMotion=createTokenMotion(position(-20,0));
    updateTokenMotion(rightMotion,position(300,24,'3:0'),0,true);
    const right=constrainTokenMotion(rightMotion,64,{...options,side:'right',query:()=>({left:0,right:200})});
    expect(40+right.left).toBe(200+24);
    expect(40+right.left+64).toBeLessThanOrEqual(500);
  });

  it('uses the safe final row when the contour closes the intermediate row',()=>{
    const motion=createTokenMotion(position(100,0)),target=position(0,48,'3:0');
    updateTokenMotion(motion,target,0,true);
    const shown=constrainTokenMotion(motion,64,{left:40,top:0,right:500,minimumLeft:0,lineHeight:24,side:'left',
      query:top=>top<40?{left:48,right:500}:null});
    expect(shown).toEqual(target);
    expect(motion.active).toBe(false);
  });
});
