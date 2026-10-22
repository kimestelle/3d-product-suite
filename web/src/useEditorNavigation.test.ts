import {beforeEach, afterEach, describe, expect, it, vi} from 'vitest';

const hooks=vi.hoisted(()=>({slots:[] as any[],cursor:0,effects:[] as (()=>void|(()=>void))[],cleanups:[] as (()=>void)[]}));
vi.mock('react',()=>({
  useState:(initial:any)=>{const index=hooks.cursor++;if(!(index in hooks.slots))hooks.slots[index]=typeof initial==='function'?initial():initial;return [hooks.slots[index],(next:any)=>{hooks.slots[index]=typeof next==='function'?next(hooks.slots[index]):next}]},
  useRef:(initial:any)=>{const index=hooks.cursor++;return hooks.slots[index]??(hooks.slots[index]={current:initial})},
  useCallback:(fn:any)=>fn,
  useEffect:(effect:any)=>{const index=hooks.cursor++;if(!(index in hooks.slots)){hooks.slots[index]=true;hooks.effects.push(effect)}},
}));
vi.mock('./frameHistory',()=>({pushFrameHistory:(url:string)=>window.history.pushState({},'',url)}));
import {useEditorNavigation} from './useEditorNavigation';

function render(){hooks.cursor=0;const result=useEditorNavigation();for(const effect of hooks.effects.splice(0)){const cleanup=effect();if(cleanup)hooks.cleanups.push(cleanup)}return result}
let pushes:string[];
function open(url:string){
  const target=new EventTarget();let location=new URL(url,'https://gesso.test');pushes=[];
  Object.defineProperty(target,'location',{get:()=>location});
  Object.assign(target,{history:{state:{},pushState:(_state:any,_title:string,next:string)=>{pushes.push(next);location=new URL(next,location)},replaceState:(_state:any,_title:string,next:string)=>{location=new URL(next,location)}}});
  vi.stubGlobal('window',target);
}
beforeEach(()=>{hooks.slots=[];hooks.cursor=0;hooks.effects=[];hooks.cleanups=[];open('/?step=film&layer=animation')});
afterEach(()=>{hooks.cleanups.forEach(cleanup=>cleanup());vi.unstubAllGlobals()});

describe('integrated export navigation',()=>{
  it('enters export and its mode in a single history entry',()=>{
    const nav=render();nav.navigate('renders','Output','still');
    expect(pushes).toEqual(['/?step=film&layer=output&mode=still']);
    expect(render()).toMatchObject({tab:'renders',layer:'Output',mode:'still'});
  });
  it('returns Film to its editing layer after Export and another workspace',()=>{
    render().navigate('renders','Output');render().chooseGroup('product');render().chooseGroup('renders');
    expect(render()).toMatchObject({tab:'renders',layer:'Animation'});
  });
  it('opens bookmarked export and gives Film a useful default',()=>{
    open('/?step=film&layer=output&mode=still');
    expect(render()).toMatchObject({tab:'renders',layer:'Output',mode:'still'});
    render().chooseGroup('renders');expect(render()).toMatchObject({layer:'Framing',mode:'still'});
  });
  it('restores Export on browser history without adding a navigation entry',()=>{
    render().navigate('renders','Output');render().chooseGroup('world');pushes=[];
    window.history.replaceState({},'','/?step=film&layer=output&mode=still');window.dispatchEvent(new Event('popstate'));
    expect(render()).toMatchObject({tab:'renders',layer:'Output',mode:'still'});expect(pushes).toEqual([]);
    render().chooseGroup('renders');expect(render().layer).toBe('Animation');
  });
});
