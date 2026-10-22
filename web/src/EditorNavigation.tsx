import {groups,layers,type EditorGroup} from './navigation';
import type {CSSProperties} from 'react';
import optionIcon from './assets/gesso/option-tab.svg';
import {UiIcon} from './UiIcon';
import './export-navigation.css';

const exportButtonContour = 'M22 36Q12 36 12 26V10Q12 0 22 0H178Q188 0 188 10V26Q188 36 178 36Z';
const exportTabContour = 'M0 36Q12 36 12 26V10Q12 0 22 0H178Q188 0 188 10V26Q188 36 200 36Z';

function Shortcut({digit}:{digit:number}) {
  return <sup className="key-hint" aria-hidden="true"><span className="key-icon"><img src={optionIcon} alt=""/></span>{digit}</sup>;
}

export default function EditorNavigation({group,onGroup,exportActive,onExport,exportDisabled=false,onRandomSetup,randomSetupActive=false}:{
  group:EditorGroup;onGroup:(group:EditorGroup)=>void;exportActive:boolean;onExport:()=>void;exportDisabled?:boolean;
  onRandomSetup?:()=>void;randomSetupActive?:boolean;
}) {
  return <nav className="gesso-layerbar gesso-workspace-navigation" aria-label="Editor navigation" data-export-active={exportActive}
    onKeyDown={event=>{if(event.key===' '&&event.target instanceof HTMLElement&&event.target.closest('button'))event.stopPropagation();}}>
    <div className="gesso-navrow" style={{'--active-tab':groups.findIndex(item=>item.id===group)} as CSSProperties}>
      <div className="gesso-tab-surface" aria-hidden="true">
        <svg viewBox="0 0 200 44" preserveAspectRatio="none">
          <path className="gesso-tab-halo" d="M-1000 44H0Q12 44 12 32V10Q12 0 22 0H178Q188 0 188 10V32Q188 44 200 44H1800"/>
          <path className="gesso-tab-fill" d="M0 44Q12 44 12 32V10Q12 0 22 0H178Q188 0 188 10V32Q188 44 200 44Z"/>
        </svg>
      </div>
      {groups.map((item,index)=><button key={item.id} type="button" className="gesso-category-button" data-category={item.id}
        aria-label={item.label} aria-pressed={!exportActive&&group===item.id} aria-keyshortcuts={`Alt+${index+1}`}
        title={`${item.label} (Option / Alt ${index+1})`} onClick={()=>onGroup(item.id)}>
        {item.label}<Shortcut digit={index+1}/>
      </button>)}
    </div>
    <div className="gesso-export-actions" role="group" aria-label="Export actions" data-with-dice={!!onRandomSetup} data-disabled={exportDisabled}>
      {onRandomSetup && <button type="button" className="gesso-random-setup-button" aria-label="Random setup"
        title="Configure random setup" aria-pressed={randomSetupActive} disabled={exportDisabled} onClick={onRandomSetup}><UiIcon name="dice"/></button>}
      <button type="button" className="gesso-export-tab gesso-export-tab-button" aria-pressed={exportActive} disabled={exportDisabled} onClick={onExport}
        style={{'--export-contour':`path("${exportActive?exportTabContour:exportButtonContour}")`} as CSSProperties}>
        <span className="gesso-export-tab-surface" aria-hidden="true"><svg viewBox="0 0 200 36" preserveAspectRatio="none">
          <path className="gesso-export-tab-fill" d={exportActive?exportTabContour:exportButtonContour}/>
        </svg></span>
        <span className="gesso-export-tab-label">Export</span>
      </button>
    </div>
  </nav>;
}

/** Layer choices stay pinned above the specimen and share Product's quiet row. */
export function EditorLayerNavigation({group,layer,onLayer}:{group:'product'|'world';layer:string;onLayer:(layer:string)=>void}) {
  const labels:Record<string,string>={Props:'Objects',Lights:'Lighting'};
  return <nav className="gesso-sidebar-layers" aria-label={`${group==='product'?'Product':'Stage'} layers`} onKeyDown={event=>{if(event.key===' ')event.stopPropagation();}}>
    {layers[group].map((name,index)=>{const label=labels[name]??name;return <button type="button" key={name} data-layer={name} aria-pressed={layer===name}
      aria-label={label} aria-keyshortcuts={`Alt+${index+5}`} title={`${label} (Option / Alt ${index+5})`}
      onClick={()=>onLayer(name)}>{label}<Shortcut digit={index+5}/></button>})}
  </nav>;
}
