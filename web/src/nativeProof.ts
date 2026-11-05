export type NativeProofState = 'queued'|'waiting'|'rendering'|'succeeded'|'failed'|'cancelled'|'superseded';
export type NativeProofSummary = {
  id:string;state:NativeProofState;sessionId:string;sequence:number;sourceDigest:string;frame:number;
  width:number;height:number;samples:number;imageUrl:string|null;imageSha256?:string;imageBytes?:number;
  execution?:unknown;warmSceneReused?:boolean;timings?:Record<string,number>;error?:string;
};
export type NativeProofInput = {
  scene:any;frame:number;sourceDigest:string;sourceKey:string;width:number;height:number;samples:number;
  cameraOverride?:unknown;viewLabel:string;
};
export type NativeProofImage = {url:string;sourceKey:string;viewLabel:string;proof:NativeProofSummary};
export type NativeProofView = {
  phase:'idle'|'requesting'|'queued'|'waiting'|'rendering'|'loading'|'ready'|'failed';
  image:NativeProofImage|null;requestedKey:string|null;proof:NativeProofSummary|null;error:string;
};
type Request = {controller:AbortController;sequence:number;id?:string;input:NativeProofInput};
type Dependencies = {fetch?:typeof fetch;createUrl?:(blob:Blob)=>string;revokeUrl?:(url:string)=>void;now?:()=>number;pause?:(ms:number,signal:AbortSignal)=>Promise<void>};

export function nativeProofSize(aspect:number,maxEdge=960):{width:number;height:number}{
  if(!Number.isFinite(aspect)||aspect<=0||aspect>100||aspect<.01)throw new Error('A valid proof aspect is required.');
  const even=(value:number)=>Math.max(16,Math.round(value/2)*2);
  const width=even(aspect>=1?maxEdge:maxEdge*aspect);
  const height=even(aspect>=1?maxEdge/aspect:maxEdge);
  return {width,height};
}
function wait(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException('Proof cancelled','AbortError'));return;}
    const cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(new DOMException('Proof cancelled','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},ms);
    signal.addEventListener('abort',cancel,{once:true});
  });
}

/** A proof is a view of an immutable request, never campaign history. Keep the
 * last decoded image until a current replacement has decoded successfully. */
export function createNativeProofSession(sessionId:string,onState:(state:NativeProofView)=>void,deps:Dependencies={}){
  const fetcher=deps.fetch??fetch,createUrl=deps.createUrl??URL.createObjectURL,revokeUrl=deps.revokeUrl??URL.revokeObjectURL;
  const now=deps.now??Date.now,pause=deps.pause??wait;
  let sequence=0,current:Request|null=null,disposed=false;
  let state:NativeProofView={phase:'idle',image:null,requestedKey:null,proof:null,error:''};
  let staged:NativeProofImage|null=null;
  const emit=(next:Partial<NativeProofView>)=>{state={...state,...next};if(!disposed)onState(state);};
  const owns=(request:Request)=>!disposed&&current===request&&!request.controller.signal.aborted;
  const releaseStaged=()=>{if(staged){revokeUrl(staged.url);staged=null;}};
  const call=async(path:string,method='GET',body?:unknown,signal?:AbortSignal)=>{
    const response=await fetcher(path,{method,credentials:'same-origin',signal,
      ...(body===undefined?{}:{headers:{'Content-Type':'application/json','X-Product-Suite':'1'},body:JSON.stringify(body)})});
    const value=await response.json();
    if(!response.ok)throw new Error(value.error||'The render proof could not be prepared.');
    return value;
  };
  const cancelRemote=(request:Request)=>{
    // The sequence watermark also handles an aborted POST whose ID never arrived.
    void call('/api/proofs/session/cancel','POST',{sessionId,sequence:request.sequence}).catch(()=>{});
  };
  const stop=(remote=true)=>{
    const old=current;current=null;
    if(old){old.controller.abort();if(remote)cancelRemote(old);}
    releaseStaged();
  };
  const verify=(value:NativeProofSummary,request:Request)=>{
    const input=request.input;
    if(!value||!/^[a-z0-9-]{1,80}$/.test(value.id)||value.sessionId!==sessionId||value.sequence!==request.sequence
      ||value.sourceDigest!==input.sourceDigest||value.frame!==input.frame||value.width!==input.width||value.height!==input.height
      ||value.samples!==input.samples||!['queued','waiting','rendering','succeeded','failed','cancelled','superseded'].includes(value.state)){
      throw new Error('The proof does not match the current scene, camera or frame.');
    }
    if(value.state==='succeeded'&&value.imageUrl!==`/api/proofs/${value.id}/image.png`)throw new Error('The proof image has an invalid source.');
  };
  const start=(input:NativeProofInput)=>{
    if(disposed)return;
    stop();
    const request:Request={controller:new AbortController(),sequence:++sequence,input:structuredClone(input)};
    current=request;emit({phase:'requesting',requestedKey:input.sourceKey,proof:null,error:''});
    void(async()=>{
      try{
        let proof=await call('/api/proofs','POST',{scene:request.input.scene,frame:input.frame,sessionId,sequence:request.sequence,
          width:input.width,height:input.height,samples:input.samples,...(input.cameraOverride?{cameraOverride:input.cameraOverride}:{})},request.controller.signal) as NativeProofSummary;
        const deadline=now()+300_000;
        let delay=350;
        while(owns(request)){
          verify(proof,request);request.id=proof.id;
          if(proof.state==='succeeded'){
            const response=await fetcher(proof.imageUrl!,{credentials:'same-origin',signal:request.controller.signal});
            if(!response.ok)throw new Error('The completed proof image is unavailable.');
            const blob=await response.blob();
            if(!owns(request))return;
            if(blob.size<=0||blob.size>32*1024*1024||!blob.type.startsWith('image/png'))throw new Error('The proof image is empty or unsupported.');
            releaseStaged();staged={url:createUrl(blob),sourceKey:input.sourceKey,viewLabel:input.viewLabel,proof};
            emit({phase:'loading',proof});return;
          }
          if(proof.state==='failed')throw new Error(proof.error||'The render proof failed. The previous proof is retained.');
          if(proof.state==='cancelled'||proof.state==='superseded'){current=null;emit({phase:state.image?'ready':'idle',requestedKey:null,proof:null});return;}
          emit({phase:proof.state,proof});
          if(now()>deadline)throw new Error('The proof took too long. Try again when the renderer is available.');
          await pause(delay,request.controller.signal);delay=Math.min(1200,delay*1.25);
          if(!owns(request))return;
          proof=await call(`/api/proofs/${proof.id}`,'GET',undefined,request.controller.signal);
        }
      }catch(error){
        if(!owns(request))return;
        cancelRemote(request);current=null;releaseStaged();
        emit({phase:'failed',error:error instanceof Error?error.message:'The proof failed. The previous proof is retained.'});
      }
    })();
  };
  return {
    start,
    cancel(){stop();emit({phase:state.image?'ready':'idle',requestedKey:null,proof:null,error:''});},
    pendingImage(){return staged;},
    imageReady(url:string,width:number,height:number){
      if(!staged||staged.url!==url||!current||!owns(current))return;
      if(width!==staged.proof.width||height!==staged.proof.height){this.imageFailed(url);return;}
      const previous=state.image;const image=staged;staged=null;current=null;
      emit({phase:'ready',image,requestedKey:image.sourceKey,proof:image.proof,error:''});
      if(previous&&previous.url!==image.url)revokeUrl(previous.url);
    },
    imageFailed(url:string){
      if(!staged||staged.url!==url)return;
      releaseStaged();current=null;emit({phase:'failed',error:'The proof image could not be decoded. The previous proof is retained.'});
    },
    clear(){stop();if(state.image)revokeUrl(state.image.url);emit({phase:'idle',image:null,requestedKey:null,proof:null,error:''});},
    dispose(){stop();if(state.image)revokeUrl(state.image.url);disposed=true;state={...state,image:null};},
  };
}
