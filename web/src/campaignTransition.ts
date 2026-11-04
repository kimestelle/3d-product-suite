export interface CampaignOwner {projectId:string;revisionId:string;scene:unknown}
export interface ImportRequest {owner:CampaignOwner;controller:AbortController}
export const sameCampaignOwner=(a:CampaignOwner,b:CampaignOwner)=>a.projectId===b.projectId&&a.revisionId===b.revisionId&&a.scene===b.scene;

/** The upload may finish on the server after the form closes. Only its current
 * source owner may install it into this editor; the imported campaign is retained. */
export function createImportRequestGuard() {
  let current:ImportRequest|null=null;
  return {
    begin(owner:CampaignOwner):ImportRequest{current?.controller.abort();return current={owner,controller:new AbortController()};},
    accepts(request:ImportRequest,owner:CampaignOwner):boolean{return current===request&&!request.controller.signal.aborted&&sameCampaignOwner(request.owner,owner);},
    finish(request:ImportRequest):boolean{if(current!==request)return false;current=null;return true;},
    cancel(){current?.controller.abort();current=null;},
  };
}
