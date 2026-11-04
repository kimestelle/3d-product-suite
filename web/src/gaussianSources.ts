/** Preview density changes bytes only. The canonical asset owns world alignment. */
export function gaussianRenderAsset(environment:any,capture:boolean):any {
  return !capture&&environment.previewAsset?environment.previewAsset:environment.asset;
}

/** Fetch the immutable source before a full-quality snapshot; abort and cap I/O. */
export async function loadGaussianSourceBytes(asset:any,url:string,signal:AbortSignal):Promise<ArrayBuffer> {
  const path=asset?.path,format=asset?.format,hash=asset?.sha256;
  if(!['spz','ply'].includes(format)||!/^[a-f0-9]{64}$/.test(hash??'')
    ||typeof path!=='string'||/[\\:\0]/.test(path)||path.startsWith('/')
    ||path.split('/').some((part:string)=>!part||part==='.'||part==='..')
    ||path.split('/').at(-1)!==`${hash}.${format}`)throw new Error('The Gaussian source must declare a safe, content-addressed SPZ or PLY.');
  const response=await fetch(url,{signal,credentials:'same-origin'});
  if(!response.ok)throw new Error(`Could not load the full-resolution Gaussian (${response.status}).`);
  const limit=128*1024*1024,declared=response.headers.get('Content-Length');
  if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw new Error('The Gaussian source exceeds the 128 MiB limit.');
  let bytes:ArrayBuffer;
  if(response.body){
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
    try {
      while(true){
        if(signal.aborted)throw new DOMException('Gaussian capture cancelled.','AbortError');
        const {done,value}=await reader.read();if(done)break;
        length+=value.byteLength;
        if(length>limit)throw new Error('The Gaussian source exceeds the 128 MiB limit.');
        chunks.push(value);
      }
    }catch(error){await reader.cancel().catch(()=>{});throw error;}
    finally{reader.releaseLock();}
    const combined=new Uint8Array(length);let offset=0;
    for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}
    bytes=combined.buffer;
  }else bytes=await response.arrayBuffer();
  if(!bytes.byteLength||bytes.byteLength>limit)throw new Error('The Gaussian source is empty or exceeds 128 MiB.');
  if(signal.aborted)throw new DOMException('Gaussian capture cancelled.','AbortError');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
  if(signal.aborted)throw new DOMException('Gaussian capture cancelled.','AbortError');
  if(digest!==hash)throw new Error('The Gaussian source SHA-256 does not match its immutable scene revision.');
  return bytes;
}
