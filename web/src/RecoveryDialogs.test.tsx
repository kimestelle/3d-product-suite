import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {RecoverDraftDialog,ImportDecisionDialog} from './RecoveryDialogs';
import type {RecoveryDraft} from './draftRecovery';
const draft:RecoveryDraft={schemaVersion:1,id:'one',projectId:'watch',projectName:'Auden watch',baseRevisionId:'saved-a',updatedAt:'2026-11-04T12:00:00.000Z',token:'token',scene:{}};
describe('work-preservation decisions',()=>{
  it('offers an explicit restore/discard choice and separates changed saved revisions',()=>{
    const props={drafts:[draft],busy:false,error:'',onRestore:vi.fn(),onDiscard:vi.fn(),onKeepSaved:vi.fn()};
    expect(renderToStaticMarkup(<RecoverDraftDialog {...props} revisionId="saved-a"/>)).toContain('Restore draft');
    const changed=renderToStaticMarkup(<RecoverDraftDialog {...props} revisionId="saved-b"/>);
    expect(changed).toContain('Restore as new campaign');expect(changed).toContain('Discard draft');expect(changed).toContain('Use saved revision');
    expect(renderToStaticMarkup(<RecoverDraftDialog {...props} revisionId="saved-a" separate/>)).toContain('current scene has unsaved changes');
  });
  it('keeps dirty import save, discard and cancel decisions distinct while reporting failed saves',()=>{
    const html=renderToStaticMarkup(<ImportDecisionDialog projectName="Auden watch" busy={false} error="Revision changed" onSave={vi.fn()} onDiscard={vi.fn()} onCancel={vi.fn()}/>);
    for(const text of ['Save + import','Discard + import','Cancel','Revision changed'])expect(html).toContain(text);
    expect(html).toContain('role="alert"');
  });
});
