import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {clearCache,prepareWithSegments} from '@chenglou/pretext';
import {layoutContourText,type LineFlowLeaf} from './philosophyLineLayout';

let canvasMeasurements = 0;
class TestCanvas {
  getContext() {
    return {font:'16px sans-serif',letterSpacing:'0px',measureText(text:string) {
      canvasMeasurements++;
      const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16);
      const width = [...text].length * size / 2;
      return {width,actualBoundingBoxLeft:0,actualBoundingBoxRight:width};
    }};
  }
}
const leaf = (value:string,overrides:Partial<LineFlowLeaf> = {}):LineFlowLeaf => ({
  prepared:prepareWithSegments(value,'400 16px "Halyard Text"'),
  lineHeight:24,top:0,left:0,width:360,naturalHeight:24,...overrides,
});
const normalize = (text:string) => text.replace(/\s+/g,' ').trim();
const article = 'A campaign is made in revisions. A new label. Another finish. A different room. Two more frames before the cut.';
beforeAll(() => vi.stubGlobal('OffscreenCanvas',TestCanvas));
beforeEach(() => {clearCache();canvasMeasurements=0;});
afterAll(() => {clearCache();vi.unstubAllGlobals();});

describe('per-line contour text layout',() => {
  it('wraps each left-side line to a different contour width without crossing it',() => {
    const query = (top:number,bottom:number) => ({left:380 - Math.max(0,bottom)*.8,right:580});
    const options = {left:40,top:20,right:660,side:'left' as const,query,gap:24};
    const result = layoutContourText([leaf(article)],options);
    expect(result.lines.length).toBeGreaterThan(3);
    for (const line of result.lines) {
      const band = query(options.top+line.top-4,options.top+line.top+24+4);
      expect(options.left+line.left+line.width).toBeLessThanOrEqual(band.left-24);
      expect(line.left).toBe(0);
    }
    expect(new Set(result.lines.map(line => line.width)).size).toBeGreaterThan(1);
    expect(normalize(result.lines.map(line => line.text).join(' '))).toBe(article);
  });

  it('places right-side lines along the curved edge while retaining the right padding',() => {
    const query = (top:number,bottom:number) => bottom < 140 ?
      {left:0,right:170 - Math.max(0,top)*.4} : null;
    const options = {left:40,top:0,right:500,side:'right' as const,query,gap:24};
    const result = layoutContourText([leaf(article)],options);
    expect(new Set(result.lines.map(line => line.left)).size).toBeGreaterThan(1);
    for (const line of result.lines) {
      const edge = query(line.top-4,line.top+28);
      if (edge) expect(40+line.left).toBeGreaterThanOrEqual(edge.right+24);
      expect(40+line.left+line.width).toBeLessThanOrEqual(500);
      expect(line.width).toBeLessThanOrEqual(360);
    }
    expect(normalize(result.lines.map(line => line.text).join(' '))).toBe(article);
  });

  it('skips completely blocked bands without consuming any source words',() => {
    const query = (top:number) => top < 50 ? {left:0,right:600} : null;
    const result = layoutContourText([leaf('Keep the product visible.')],{
      left:40,top:0,right:500,side:'left',query,
    });
    expect(result.lines[0].top).toBe(72);
    expect(result.lines[0].text).toBe('Keep the product visible.');
    expect(result.leafHeights).toEqual([96]);
    expect(result.leafTops).toEqual([0]);
  });

  it('preserves authored paragraph gaps after skipped bands and added text rows',() => {
    const result = layoutContourText([
      leaf('alpha beta gamma delta',{width:120,naturalHeight:48}),
      leaf('next',{top:64,width:120,naturalHeight:24}),
    ],{left:40,top:0,right:500,side:'left',query:top => top < 20 ? {left:0,right:600} : null});
    const firstLines = result.lines.filter(line=>line.leaf===0);
    const secondLine = result.lines.find(line=>line.leaf===1)!;
    const lastFirst = firstLines.at(-1)!;
    expect(secondLine.top-(lastFirst.top+24)).toBe(16);
    expect(result.leafTops[1]).toBe(64+result.leafHeights[0]-48);
    expect(result.height).toBe(secondLine.top+24);
  });

  it('preserves explicit line breaks and all long-word graphemes',() => {
    const value = 'first\nsecond\n\nfinal';
    const explicit = layoutContourText([leaf(value,{
      prepared:prepareWithSegments(value,'400 16px "Halyard Text"',{whiteSpace:'pre-wrap'}),
      width:400,
    })],{left:40,top:0,right:500,side:'left',query:()=>null});
    expect(explicit.lines.map(line=>line.text.trim())).toEqual(['first','second','','final']);
    expect(explicit.lines.map(line=>line.top)).toEqual([0,24,48,72]);
    expect(explicit.lines.map(line=>line.text+line.separator).join('')).toBe(value);
    const word = 'uninterruptedmaterialmapping';
    const broken = layoutContourText([leaf(word,{width:32})],{
      left:40,top:0,right:500,side:'left',query:()=>null,
    });
    expect(broken.lines.map(line=>line.text).join('')).toBe(word);
    expect(broken.lines.every(line=>line.width<=32)).toBe(true);
  });

  it('reconstructs source text without adding spaces within wrapped words',()=>{
    const value='one uninterruptedmaterialmapping two.';
    const result=layoutContourText([leaf(value,{width:40})],{
      left:40,top:0,right:500,side:'left',query:()=>null,
    });
    expect(result.lines.map(line=>line.text+line.separator).join('')).toBe(value);
    expect(result.lines.some(line=>line.text==='unint'&&line.separator==='')).toBe(true);
    const preserved='first  second\n\nthird';
    const spaced=layoutContourText([leaf(preserved,{width:48,
      prepared:prepareWithSegments(preserved,'400 16px "Halyard Text"',{whiteSpace:'pre-wrap'}),
    })],{left:40,top:0,right:500,side:'left',query:()=>null});
    expect(spaced.lines.map(line=>line.text+line.separator).join('')).toBe(preserved);
  });

  it('replays the same contour exactly without further font measurement',() => {
    const leaves = [leaf(article)];
    const measurements = canvasMeasurements;
    const at = (offset:number) => layoutContourText(leaves,{
      left:40,top:0,right:700,side:'right',
      query:(top,bottom)=>bottom<160?{left:0,right:160+offset-top*.3}:null,
    });
    const offsets = [0,20,40,60,80];
    const forward = offsets.map(at);
    const reverse = [...offsets].reverse().map(at).reverse();
    expect(reverse).toEqual(forward);
    expect(canvasMeasurements).toBe(measurements);
  });

  it('waits for a whole heading word and its punctuation to fit the contour',()=>{
    const heading=leaf('painting.',{
      prepared:prepareWithSegments('painting.','500 40px "Halyard Display"'),
      width:240,lineHeight:48,naturalHeight:48,preserveWords:true,
    });
    const result=layoutContourText([heading],{
      left:40,top:0,right:500,side:'left',
      query:top=>top<80?{left:40+24+140,right:500}:null,
    });
    expect(result.lines.map(line=>line.text)).toEqual(['painting.']);
    expect(result.lines[0].top).toBe(96);
    expect(result.lines[0].width).toBe(180);
    expect(result.leafHeights).toEqual([144]);
  });

  it('preserves the complete title and every word as the contour narrows and reverses',()=>{
    const title='A ground applied to a surface before painting.';
    const heading=leaf(title,{
      prepared:prepareWithSegments(title,'500 40px "Halyard Display"'),
      width:300,lineHeight:48,naturalHeight:192,preserveWords:true,
    });
    const measurements=canvasMeasurements;
    const words=new Set(title.split(' '));
    const at=(offset:number)=>layoutContourText([heading],{
      left:40,top:0,right:700,side:'left',
      query:top=>top<420?{left:40+24+160+offset+Math.sin(top/60)*32,right:600}:null,
    });
    const offsets=[-32,-16,0,16,32];
    const forward=offsets.map(at);
    expect([...offsets].reverse().map(at).reverse()).toEqual(forward);
    for(const result of forward){
      expect(result.lines.map(line=>line.text+line.separator).join('')).toBe(title);
      expect(result.lines.flatMap(line=>line.text.trim().split(/\s+/)).every(word=>words.has(word))).toBe(true);
      expect(result.lines.at(-1)!.text.trim()).toBe('painting.');
    }
    expect(canvasMeasurements).toBe(measurements);
  });

  it('bounds heading recovery when its word cannot fit, without changing body wrapping',()=>{
    const value='painting.';
    const prepared=prepareWithSegments(value,'500 40px "Halyard Display"');
    const options={left:40,top:0,right:500,side:'left' as const,query:()=>null};
    expect(()=>layoutContourText([leaf(value,{prepared,width:140,preserveWords:true})],options))
      .toThrow('narrower than one heading word');
    expect(()=>layoutContourText([leaf(value,{prepared,width:240,preserveWords:true})],{
      ...options,query:()=>({left:40+24+140,right:500}),
    })).toThrow('no readable text lane');
    const body=layoutContourText([leaf(value,{prepared,width:140})],options);
    expect(body.lines.map(line=>line.text).join('')).toBe(value);
    expect(body.lines.map(line=>line.text)).toEqual(['paintin','g.']);
  });

  it('does not create rows or measurement text for an empty paragraph',() => {
    const result = layoutContourText([leaf('',{naturalHeight:0})],{
      left:40,top:0,right:500,side:'left',query:()=>({left:0,right:600}),
    });
    expect(result).toEqual({height:0,lines:[],leafHeights:[0],leafTops:[0]});
  });

  it('reports impossible lanes rather than clipping or dropping source text',() => {
    expect(()=>layoutContourText([leaf('source')],{
      left:40,top:0,right:500,side:'left',query:()=>({left:0,right:600}),
    })).toThrow('no readable text lane');
    expect(()=>layoutContourText([leaf('source',{width:2})],{
      left:40,top:0,right:500,side:'left',query:()=>null,
    })).toThrow('narrower than one text grapheme');
  });
});
