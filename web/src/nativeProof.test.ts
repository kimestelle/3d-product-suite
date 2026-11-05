import {beforeEach,describe,expect,it,vi} from 'vitest';
import {createNativeProofSession,nativeProofSize,type NativeProofInput,type NativeProofSummary,type NativeProofView} from './nativeProof';

const input:NativeProofInput={scene:{product:{id:'watch'}},frame:18,sourceDigest:'source',sourceKey:'view-a',width:540,height:960,samples:32,viewLabel:'Shot camera'};
const proof=(extra:Partial<NativeProofSummary>={}):NativeProofSummary=>({id:'proof-a',state:'succeeded',sessionId:'session',sequence:1,sourceDigest:'source',frame:18,width:540,height:960,samples:32,imageUrl:'/api/proofs/proof-a/image.png',...extra});
// Fetch is controlled here: native Response body streams settle differently
// across Node versions and can outlive a test's request-ownership assertions.
// Actual HTTP and PNG decoding are exercised by the API and browser checks.
const json=(value:unknown,status=200)=>({ok:status>=200&&status<300,json:async()=>structuredClone(value)}) as Response;
const png=()=>({ok:true,blob:async()=>new Blob(['image'],{type:'image/png'})}) as Response;
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};

describe('native proof request ownership',()=>{
  let states:NativeProofView[],fetcher:ReturnType<typeof vi.fn>,release:ReturnType<typeof vi.fn>,make:ReturnType<typeof vi.fn>;
  beforeEach(()=>{states=[];release=vi.fn();make=vi.fn().mockReturnValue('blob:proof-1');
    fetcher=vi.fn(async(path:string)=>path.endsWith('/image.png')?png():path.endsWith('/cancel')?json({state:'cancelled'}):json(proof()));});
  const setup=(extra:any={})=>createNativeProofSession('session',value=>states.push(value),{fetch:fetcher as any,createUrl:make,revokeUrl:release,pause:async()=>{},...extra});
  it('scales the proof without changing its intended orientation',()=>{
    expect(nativeProofSize(9/16)).toEqual({width:540,height:960});expect(nativeProofSize(16/9)).toEqual({width:960,height:540});
    expect(()=>nativeProofSize(NaN)).toThrow('aspect');
  });
  it('only renders on request, snapshots the source, and waits for image decode',async()=>{
    const session=setup(),source=structuredClone(input);expect(fetcher).not.toHaveBeenCalled();session.start(source);source.scene.product.id='changed';
    await flush();expect(JSON.parse(fetcher.mock.calls[0][1].body).scene.product.id).toBe('watch');
    expect(states.at(-1)?.phase).toBe('loading');expect(states.at(-1)?.image).toBeNull();
    session.imageReady('blob:proof-1',540,960);expect(states.at(-1)?.phase).toBe('ready');expect(states.at(-1)?.image?.sourceKey).toBe('view-a');session.dispose();
  });
  it('does not publish another scene, frame, size or request as the current proof',async()=>{
    for(const mismatch of [{sourceDigest:'other'},{frame:19},{width:541},{sequence:2},{sessionId:'other'},{samples:16}]){
      fetcher.mockImplementation(async(path:string)=>path.endsWith('/cancel')?json({}):json(proof(mismatch)));
      const session=setup();session.start(input);await flush();expect(states.at(-1)?.phase).toBe('failed');expect(make).not.toHaveBeenCalled();session.dispose();
    }
  });
  it('does not fetch a foreign artifact URL with workspace credentials',async()=>{
    fetcher.mockResolvedValue(json(proof({imageUrl:'https://other.test/private.png'})));const session=setup();session.start(input);await flush();
    expect(states.at(-1)?.phase).toBe('failed');expect(fetcher.mock.calls.some(call=>call[0].startsWith('https:'))).toBe(false);session.dispose();
  });
  it('polls only until a complete current result and then stops',async()=>{
    let polls=0;fetcher.mockImplementation(async(path:string)=>path.endsWith('/image.png')?png():path.endsWith('/cancel')?json({}):json(proof({state:polls++?'succeeded':'waiting'})));
    const session=setup();session.start(input);await flush();expect(states.some(state=>state.phase==='waiting')).toBe(true);expect(states.at(-1)?.phase).toBe('loading');expect(polls).toBe(2);session.dispose();
  });
  it('a late superseded submission cannot replace a newer proof',async()=>{
    const first=deferred<Response>();fetcher.mockImplementation(async(path:string,options:any)=>{
      if(path.endsWith('/cancel'))return json({});if(path.endsWith('/image.png'))return png();
      const body=options?.body&&JSON.parse(options.body);return body.sequence===1?first.promise:json(proof({sequence:2,id:'proof-b',imageUrl:'/api/proofs/proof-b/image.png'}));
    });
    const session=setup();session.start(input);session.start({...input,sourceKey:'view-b'});await flush();
    first.resolve(json(proof()));await flush();session.imageReady('blob:proof-1',540,960);
    expect(states.at(-1)?.image?.sourceKey).toBe('view-b');expect(make).toHaveBeenCalledTimes(1);session.dispose();
  });
  it('keeps the previous decoded image when a replacement fails',async()=>{
    const session=setup();session.start(input);await flush();session.imageReady('blob:proof-1',540,960);
    fetcher.mockImplementation(async(path:string)=>path.endsWith('/cancel')?json({}):json(proof({state:'failed',sequence:2,error:'Driver unavailable'})));
    session.start({...input,sourceKey:'view-b'});await flush();expect(states.at(-1)?.phase).toBe('failed');expect(states.at(-1)?.image?.sourceKey).toBe('view-a');expect(release).not.toHaveBeenCalled();session.dispose();
  });
  it('keeps the prior image until a current replacement decodes, then releases it',async()=>{
    make.mockReturnValueOnce('blob:old').mockReturnValueOnce('blob:new');const session=setup();session.start(input);await flush();session.imageReady('blob:old',540,960);
    fetcher.mockImplementation(async(path:string)=>path.endsWith('/cancel')?json({}):path.endsWith('/image.png')?png():json(proof({sequence:2})));
    session.start({...input,sourceKey:'view-b'});await flush();expect(states.at(-1)?.image?.url).toBe('blob:old');expect(release).not.toHaveBeenCalled();
    session.imageReady('blob:new',540,960);expect(states.at(-1)?.image?.url).toBe('blob:new');expect(release).toHaveBeenCalledWith('blob:old');session.dispose();
  });
  it('rejects an image with unexpected decoded dimensions',async()=>{
    const session=setup();session.start(input);await flush();session.imageReady('blob:proof-1',1,1);expect(states.at(-1)?.phase).toBe('failed');expect(release).toHaveBeenCalledWith('blob:proof-1');session.dispose();
  });
  it('cancel invalidates an unknown remote submission through its session watermark',async()=>{
    const submitted=deferred<Response>();fetcher.mockImplementation(async(path:string)=>path.endsWith('/cancel')?json({}):submitted.promise);
    const session=setup();session.start(input);session.cancel();submitted.resolve(json(proof()));await flush();expect(states.at(-1)?.phase).toBe('idle');expect(make).not.toHaveBeenCalled();
    const cancel=fetcher.mock.calls.find(call=>call[0]==='/api/proofs/session/cancel');expect(JSON.parse(cancel![1].body)).toEqual({sessionId:'session',sequence:1});session.dispose();
  });
  it('disposal cancels work and releases images without publishing late state',async()=>{
    const session=setup();session.start(input);await flush();session.imageReady('blob:proof-1',540,960);const count=states.length;session.dispose();await flush();expect(states).toHaveLength(count);expect(release).toHaveBeenCalledWith('blob:proof-1');
  });
});
