type ExportJobPoller<Jobs, Pairs> = {
  readJobs:(signal:AbortSignal)=>Promise<Jobs>;
  readPairs:(signal:AbortSignal)=>Promise<Pairs>;
  onJobs:(jobs:Jobs)=>void;
  onPairs:(pairs:Pairs)=>void;
};

const ACTIVE_POLL_INTERVAL=1800;
const IDLE_POLL_INTERVALS=[1800,5000,15000];

/** A pair may still be assembling while one child is queued or rendering. */
function hasActiveWork(value:unknown):boolean {
  if(Array.isArray(value))return value.some(hasActiveWork);
  if(!value||typeof value!=='object')return false;
  const job=value as {state?:unknown;children?:Record<string,unknown>};
  return job.state==='queued'||job.state==='running'
    ||!!job.children&&Object.values(job.children).some(hasActiveWork);
}

/** Retained editor pages keep their jobs, but only the visible editor polls.
 * Wait for both reads before scheduling another pair; a slow request cannot
 * build a queue. Each result also checks its generation after cancellation.
 * Idle editors settle at 15s; active work/errors retain the 1.8s interval.
 * Focus and explicit local mutations bypass the idle delay.
 */
export function startExportJobPolling<Jobs, Pairs>({readJobs,readPairs,onJobs,onPairs}:ExportJobPoller<Jobs,Pairs>) {
  let disposed=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let request:AbortController|null=null;
  let idleRounds=0;
  const refresh=async()=>{
    timer=undefined;
    if(disposed||document.hidden||request)return;
    const current=new AbortController();request=current;
    const accept=()=>!disposed&&!document.hidden&&!current.signal.aborted&&request===current;
    const results=await Promise.allSettled([
      Promise.resolve().then(()=>readJobs(current.signal)).then(jobs=>{if(accept())onJobs(jobs);return jobs;}),
      Promise.resolve().then(()=>readPairs(current.signal)).then(pairs=>{if(accept())onPairs(pairs);return pairs;}),
    ]);
    if(request!==current)return;
    request=null;
    if(disposed||document.hidden)return;
    // A return from a hidden tab should not wait for the normal interval.
    if(current.signal.aborted)void refresh();
    else {
      const active=results.some(result=>result.status==='rejected'||hasActiveWork(result.value));
      if(active)idleRounds=0;
      const delay=active?ACTIVE_POLL_INTERVAL:IDLE_POLL_INTERVALS[Math.min(idleRounds++,IDLE_POLL_INTERVALS.length-1)];
      timer=setTimeout(refresh,delay);
    }
  };
  const refreshNow=()=>{
    if(disposed)return;
    idleRounds=0;
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    // Reject reads begun before a local submit/resume/cancel. Wait for their
    // cancellation before issuing another pair, preserving one request owner.
    if(request)request.abort();
    else void refresh();
  };
  const visibility=()=>{
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    if(document.hidden)request?.abort();
    else refreshNow();
  };
  document.addEventListener('visibilitychange',visibility);
  window.addEventListener('focus',refreshNow);
  void refresh();
  const dispose=()=>{
    disposed=true;
    if(timer!==undefined)clearTimeout(timer);
    request?.abort();
    document.removeEventListener('visibilitychange',visibility);
    window.removeEventListener('focus',refreshNow);
  };
  return Object.assign(dispose,{refresh:refreshNow});
}
