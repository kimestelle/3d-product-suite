import {UiIcon} from './UiIcon';
import {saveStatusPresentation, type SavePreview, type SaveStatus} from './saveStatus';
import './campaign-save-control.css';

export function CampaignSaveControl({status, preview = null, disabled, onSave}: {
  status: SaveStatus; preview?: SavePreview; disabled?: boolean; onSave: () => void;
}) {
  const {label, title} = saveStatusPresentation(status, preview);
  return status === 'unsaved'
    ? <button className="gesso-save" data-preview={preview || undefined} disabled={disabled} onClick={onSave} title={title}>{label}</button>
    : <span className="gesso-save-status" data-preview={preview || undefined} data-state={status} role="status" title={title}><UiIcon name={status === 'saved' ? 'check' : 'loader'}/>{label}</span>;
}
