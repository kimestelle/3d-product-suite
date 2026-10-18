import {groups,type EditorGroup,type EditorMode} from './navigation';
import {UiIcon} from './UiIcon';

export default function EditorNavigation({group,onGroup,mode,onMode}:{
  group:EditorGroup;onGroup:(group:EditorGroup)=>void;mode:EditorMode;onMode:(mode:EditorMode)=>void;
}) {
  return <nav className="gesso-layerbar gesso-four-navigation" aria-label="Editor navigation"
    onKeyDown={event=>{if(event.key===' '&&event.target instanceof HTMLElement&&event.target.closest('button'))event.stopPropagation();}}>
    <div className="gesso-navrow">
      {groups.map((item,index)=><button key={item.id} type="button" className="gesso-category-button" data-category={item.id}
        aria-label={item.label} aria-pressed={group===item.id} aria-keyshortcuts={`Alt+${index+1}`}
        title={`${item.label} (Option / Alt ${index+1})`} onClick={()=>onGroup(item.id)}>
        {item.label}<sup className="key-hint" aria-hidden="true"><span className="key-icon"><UiIcon name="option"/></span>{index+1}</sup>
      </button>)}
    </div>
    {group==='renders'&&<div className="gesso-film-mode" role="group" aria-label="Film format">{(['still','video'] as const).map(value=><button type="button" key={value} aria-pressed={mode===value} onClick={()=>onMode(value)}>{value==='still'?'Still':'Video'}</button>)}</div>}
  </nav>;
}
