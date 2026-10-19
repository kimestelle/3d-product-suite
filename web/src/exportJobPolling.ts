type ExportJobPoller<Jobs, Pairs> = {
  readJobs:(signal:AbortSignal)=>Promise<Jobs>;
  readPairs:(signal:AbortSignal)=>Promise<Pairs>;
  onJobs:(jobs:Jobs)=>void;
  onPairs:(pairs:Pairs)=>void;
};

/** Retained editor pages keep their jobs, but only the visible editor polls.
 * Wait for both reads before scheduling another pair; a slow request cannot
 * build a queue. Each result also checks its generation after cancellation.
 */
export function startExportJobPolling<Jobs, Pairs>({readJobs,readPairs,onJobs,onPairs}:ExportJobPoller<Jobs,Pairs>) {
  let disposed=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let request:AbortController|null=null;
  const refresh=async()=>{
    timer=undefined;
    if(disposed||document.hidden||request)return;
    const current=new AbortController();request=current;
    const accept=()=>!disposed&&!document.hidden&&!current.signal.aborted&&request===current;
    await Promise.allSettled([
      Promise.resolve().then(()=>readJobs(current.signal)).then(jobs=>{if(accept())onJobs(jobs);}),
      Promise.resolve().then(()=>readPairs(current.signal)).then(pairs=>{if(accept())onPairs(pairs);}),
    ]);
    if(request!==current)return;
    request=null;
    if(disposed||document.hidden)return;
    // A return from a hidden tab should not wait for the normal interval.
    if(current.signal.aborted)void refresh();
    else timer=setTimeout(refresh,1800);
  };
  const visibility=()=>{
    if(timer!==undefined){clearTimeout(timer);timer=undefined;}
    if(document.hidden)request?.abort();
    else void refresh();
  };
  document.addEventListener('visibilitychange',visibility);
  void refresh();
  return()=>{
    disposed=true;
    if(timer!==undefined)clearTimeout(timer);
    request?.abort();
    document.removeEventListener('visibilitychange',visibility);
  };
}
