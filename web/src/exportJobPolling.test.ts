import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {startExportJobPolling} from './exportJobPolling';

function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(reason?:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
let visibility:{hidden:boolean;listeners:Set<()=>void>;addEventListener:(name:string,handler:()=>void)=>void;removeEventListener:(name:string,handler:()=>void)=>void};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const show=(hidden:boolean)=>{visibility.hidden=hidden;for(const listener of visibility.listeners)listener();};
function setup() {
  const jobs=vi.fn<(signal:AbortSignal)=>Promise<string[]>>().mockResolvedValue(['job']);
  const pairs=vi.fn<(signal:AbortSignal)=>Promise<string[]>>().mockResolvedValue(['pair']);
  const onJobs=vi.fn(),onPairs=vi.fn();
  return {jobs,pairs,onJobs,onPairs,start:()=>startExportJobPolling({readJobs:jobs,readPairs:pairs,onJobs,onPairs})};
}
beforeEach(()=>{
  vi.useFakeTimers();
  visibility={hidden:false,listeners:new Set(),addEventListener(_name,listener){this.listeners.add(listener);},removeEventListener(_name,listener){this.listeners.delete(listener);}};
  vi.stubGlobal('document',visibility);
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('visible editor export job polling',()=>{
  it('refreshes immediately and only starts the next pair after the slowest read finishes',async()=>{
    const state=setup(),slow=deferred<string[]>();state.jobs.mockReturnValueOnce(slow.promise);
    const dispose=state.start();await flush();
    expect(state.jobs).toHaveBeenCalledTimes(1);expect(state.pairs).toHaveBeenCalledTimes(1);
    expect(state.onPairs).toHaveBeenCalledWith(['pair']);
    await vi.advanceTimersByTimeAsync(18000);expect(state.jobs).toHaveBeenCalledTimes(1);
    slow.resolve(['late job']);await flush();expect(state.onJobs).toHaveBeenCalledWith(['late job']);
    await vi.advanceTimersByTimeAsync(1799);expect(state.jobs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(state.jobs).toHaveBeenCalledTimes(2);dispose();
  });
  it('does no requests or timer work while initially hidden and refreshes on return',async()=>{
    show(true);const state=setup(),dispose=state.start();await flush();
    await vi.advanceTimersByTimeAsync(18000);expect(state.jobs).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    show(false);await flush();expect(state.jobs).toHaveBeenCalledTimes(1);expect(state.onJobs).toHaveBeenCalledWith(['job']);dispose();
  });
  it('aborts hidden reads and never accepts their stale results, even after returning',async()=>{
    const state=setup(),slow=deferred<string[]>();state.jobs.mockReturnValueOnce(slow.promise);
    const dispose=state.start();await flush();const signal=state.jobs.mock.calls[0][0];
    show(true);expect(signal.aborted).toBe(true);show(false);await flush();
    expect(state.jobs).toHaveBeenCalledTimes(1);
    slow.resolve(['stale']);await flush();
    expect(state.onJobs).not.toHaveBeenCalledWith(['stale']);expect(state.jobs).toHaveBeenCalledTimes(2);
    expect(state.onJobs).toHaveBeenCalledWith(['job']);dispose();
  });
  it('cancels a pending timer on hide and resumes without the polling delay',async()=>{
    const state=setup(),dispose=state.start();await flush();expect(vi.getTimerCount()).toBe(1);
    show(true);expect(vi.getTimerCount()).toBe(0);await vi.advanceTimersByTimeAsync(18000);expect(state.jobs).toHaveBeenCalledTimes(1);
    show(false);await flush();expect(state.jobs).toHaveBeenCalledTimes(2);dispose();
  });
  it('keeps the healthy endpoint updating and retries when the other endpoint fails',async()=>{
    const state=setup();state.jobs.mockRejectedValueOnce(new Error('offline'));
    const dispose=state.start();await flush();expect(state.onJobs).not.toHaveBeenCalled();expect(state.onPairs).toHaveBeenCalledWith(['pair']);
    await vi.advanceTimersByTimeAsync(1800);expect(state.jobs).toHaveBeenCalledTimes(2);expect(state.onJobs).toHaveBeenCalledWith(['job']);dispose();
  });
  it('disposal aborts work, removes listeners, and prevents late writes or new requests',async()=>{
    const state=setup(),slow=deferred<string[]>();state.jobs.mockReturnValueOnce(slow.promise);
    const dispose=state.start();await flush();const signal=state.jobs.mock.calls[0][0];dispose();
    expect(signal.aborted).toBe(true);expect(visibility.listeners.size).toBe(0);
    slow.resolve(['stale']);await flush();show(true);show(false);await vi.advanceTimersByTimeAsync(18000);
    expect(state.onJobs).not.toHaveBeenCalled();expect(state.jobs).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
  });
});
