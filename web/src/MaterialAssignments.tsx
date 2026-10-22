import {useEffect, useRef, useState} from 'react';
import type {HierarchyPart} from './hierarchy';
import {attachMaterialParts, materialOwner, materialTargets, presetPartIds, type LibraryMaterialPreset} from './materialPresets';
import MaterialSwatches from './MaterialSwatches';
import MaterialPresetMenu from './MaterialPresetMenu';
import {UiIcon} from './UiIcon';
import type {MaterialHover} from './materials';

const dragType = 'application/x-gesso-material-part';

/** The library is the assignment tree; source geometry remains the target identity. */
export default function MaterialAssignments({scene, parts, presets, selectedId, onEdit, onRename, onDuplicate, onDelete, onSelect, onChange, onHover}: {
  scene:any; parts:HierarchyPart[]; presets:LibraryMaterialPreset[]; selectedId?:string;
  onEdit:(preset:LibraryMaterialPreset)=>void; onSelect:(id:string)=>void;
  onRename?:(preset:LibraryMaterialPreset)=>void;
  onDuplicate?:(preset:LibraryMaterialPreset)=>void;
  onDelete?:(preset:LibraryMaterialPreset)=>void;
  onChange:(edit:(scene:any)=>void)=>void;
  onHover?:(hover:MaterialHover|null)=>void;
}) {
  const [attaching,setAttaching] = useState<string|null>(null);
  const [chosen,setChosen] = useState<string[]>([]);
  const [query,setQuery] = useState('');
  const [dragged,setDragged] = useState<string|null>(null);
  const [over,setOver] = useState<string|null>(null);
  const [status,setStatus] = useState<{message:string;tone:'success'|'error'}|null>(null);
  const presetIds=JSON.stringify(presets.map(preset=>preset.id));
  useEffect(()=>{setStatus(null);setAttaching(current=>current&&presets.some(preset=>preset.id===current)?current:null);},[presetIds]);
  const [hovered,setHovered] = useState<string|null>(null);
  const [keyboardFocus,setKeyboardFocus] = useState<string|null>(null);
  const contact=presets.find(preset=>preset.id===(hovered??keyboardFocus));
  const hoverKey=JSON.stringify(contact ? {presetId:contact.id,partIds:presetPartIds(scene,contact)} : null);
  useEffect(()=>{onHover?.(JSON.parse(hoverKey));},[hoverKey,onHover]);
  useEffect(()=>()=>onHover?.(null),[onHover]);
  useEffect(()=>{
    const clear=()=>{setHovered(null);setKeyboardFocus(null);};
    const visibility=()=>{if(document.hidden)clear();};
    window.addEventListener('blur',clear);document.addEventListener('visibilitychange',visibility);
    return()=>{window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  const attachButtons = useRef(new Map<string,HTMLButtonElement>());
  const returnFocus = useRef<string|null>(null);
  useEffect(()=>{if(!attaching&&returnFocus.current){attachButtons.current.get(returnFocus.current)?.focus({preventScroll:true});returnFocus.current=null;}},[attaching]);
  const closeAttach = () => {returnFocus.current=attaching;setAttaching(null);};
  const openAttach = (id:string) => {setAttaching(id);setChosen([]);setQuery('');};
  const targets = materialTargets(scene,parts);
  const label = (id:string) => parts.find(part=>part.id===id)?.name ?? id;
  const attach = (presetId:string, ids:string[]) => {
    try {
      attachMaterialParts(structuredClone(scene),presetId,ids,parts);
      onChange(next=>attachMaterialParts(next,presetId,ids,parts));
      setStatus({message:`${ids.length===1?label(ids[0]):ids.length+' objects / sections'} → ${presets.find(preset=>preset.id===presetId)?.name}`,tone:'success'});
      closeAttach();setChosen([]);setDragged(null);setOver(null);
    } catch(error) {setStatus({message:(error as Error).message,tone:'error'});}
  };
  const row = (part:HierarchyPart) => <li key={part.id} className="gesso-material-assignment" draggable
    onDragStart={event=>{setHovered(null);setKeyboardFocus(null);event.dataTransfer.setData(dragType,part.id);event.dataTransfer.effectAllowed='move';setDragged(part.id);}}
    onDragEnd={()=>{setDragged(null);setOver(null);}}>
    <span className="gesso-material-grip" aria-hidden="true">⠿</span>
    <button type="button" className="gesso-text-button" title={part.name} onClick={()=>onSelect(part.id)}>{part.name}</button>
    <span className="gesso-meta">{part.id===part.componentId?'Object':'Section'}</span>
  </li>;
  const source = targets.filter(part=>!materialOwner(scene,parts,part.id));
  return <>
    <p className="gesso-meta gesso-note gesso-material-library-hint">Attach objects or sections. Drag to move them.</p>
    <MaterialSwatches layout="list" items={presets.map(preset=>({...preset,description:preset.type==='custom'?'Custom material':preset.type[0].toUpperCase()+preset.type.slice(1)}))}
      selectedId={selectedId} onSelect={id=>{const preset=presets.find(item=>item.id===id);if(preset)onEdit(preset);}}
      renderActions={onDuplicate&&onDelete ? item=>{
        const preset=presets.find(entry=>entry.id===item.id)!;
        const assigned=presetPartIds(scene,preset);
        const primitive=scene.product.components.some((part:any)=>part.shape!=='mesh'&&assigned.includes(part.id));
        return <MaterialPresetMenu name={preset.name}
          deleteDescription={assigned.length ? `Remove this material from ${assigned.length===1?'1 object / section':assigned.length+' objects / sections'}? ${primitive?'Primitive objects receive Neutral; mesh sections inherit their underlying finish.':'Imported surfaces return to their underlying finish.'} Undo can restore it.` : undefined}
          onRename={()=>(onRename??onEdit)(preset)} onDuplicate={()=>onDuplicate(preset)} onDelete={()=>onDelete(preset)} onAttach={()=>openAttach(preset.id)}/>;
      }:undefined}
      itemProps={item=>({'data-material-id':item.id, 'data-drop-active':over===item.id,
        onPointerEnter:event=>{if(event.pointerType!=='touch')setHovered(item.id);},
        onPointerLeave:()=>setHovered(current=>current===item.id?null:current),
        onPointerCancel:()=>{setHovered(null);setKeyboardFocus(null);},
        onPointerDown:()=>setKeyboardFocus(null),
        onFocus:event=>{if(event.target.matches(':focus-visible'))setKeyboardFocus(item.id);},
        onBlur:event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setKeyboardFocus(current=>current===item.id?null:current);},
        onDragOver:event=>{if(dragged&&event.dataTransfer.types.includes(dragType)){event.preventDefault();event.dataTransfer.dropEffect='move';setOver(item.id);}},
        onDragLeave:event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setOver(null);},
        onDrop:event=>{event.preventDefault();const id=event.dataTransfer.getData(dragType);if(id&&id===dragged)attach(item.id,[id]);},
      })}
      renderBelow={item=>{
        const preset=presets.find(preset=>preset.id===item.id)!;
        const assigned=presetPartIds(scene,preset);
        const candidates=targets.filter(part=>!assigned.includes(part.id)&&(!query||`${part.name} ${label(part.componentId)}`.toLowerCase().includes(query.toLowerCase())));
        return <div className="gesso-material-assignments">
          {!!assigned.length&&<ul aria-label={`Objects using ${item.name}`}>{assigned.map(id=>parts.find(part=>part.id===id)).filter((part):part is HierarchyPart=>!!part).map(row)}</ul>}
          {!assigned.length&&<span className="gesso-meta gesso-note">No objects attached</span>}
          {attaching===item.id?<div className="gesso-material-attach" role="group" aria-label={`Attach to ${item.name}`} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();closeAttach();}}}>
            <input aria-label="Find objects or sections" autoFocus placeholder="Find an object or section" value={query} onChange={event=>setQuery(event.target.value)}/>
            <div className="gesso-material-attach-options">
              {candidates.map(part=>{const owner=presets.find(preset=>preset.id===materialOwner(scene,parts,part.id));return <label key={part.id} className="gesso-material-attach-option">
                <input type="checkbox" checked={chosen.includes(part.id)} onChange={event=>setChosen(current=>event.target.checked?[...current,part.id]:current.filter(id=>id!==part.id))}/>
                <span><span>{part.name}</span><small>{part.id===part.componentId?'Whole object':label(part.componentId)+' / section'} · {owner?.name??'Original material'}</small></span>
              </label>;})}
              {!candidates.length&&<p className="gesso-meta gesso-note">No matching objects or sections.</p>}
            </div>
            <div className="gesso-button-row"><button type="button" disabled={!chosen.length} onClick={()=>attach(item.id,chosen)}>Attach{chosen.length?' '+chosen.length:''}</button><button type="button" onClick={closeAttach}>Cancel</button></div>
          </div>:<button type="button" className="gesso-text-button gesso-material-attach-trigger" ref={element=>{if(element)attachButtons.current.set(item.id,element);else attachButtons.current.delete(item.id);}} aria-label={`Attach objects to ${item.name}`} onClick={()=>openAttach(item.id)}><UiIcon name="plus"/>Attach</button>}
        </div>;
      }}/>
    {!!source.length&&<details className="gesso-material-source">
      <summary>Original materials <span>{source.filter(part=>part.id!==part.componentId).length || source.length}</span></summary>
      <p className="gesso-meta gesso-note">Imported surfaces. Drag an object or section onto a material to replace its finish.</p>
      <ul aria-label="Objects using original materials">{source.map(row)}</ul>
    </details>}
    {!presets.length&&<p className="gesso-meta gesso-note">Add a material, then attach an object or section.</p>}
    <span className="gesso-meta gesso-feedback" data-tone={status?.tone} role="status">{status?.message}</span>
  </>;
}
