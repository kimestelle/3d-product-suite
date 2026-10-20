import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

export interface MaterialPresetMenuProps {
  name:string;
  deleteDescription?:string;
  onRename:()=>void;
  onDuplicate:()=>void;
  onAttach:()=>void;
  onDelete:()=>void;
}

/** The action menu is a sibling of the swatch, never a button inside its edit button. */
export default function MaterialPresetMenu({name,deleteDescription,onRename,onDuplicate,onAttach,onDelete}:MaterialPresetMenuProps) {
  const [open,setOpen]=useState(false), [confirm,setConfirm]=useState(false);
  const [position,setPosition]=useState({left:0,top:0});
  const trigger=useRef<HTMLButtonElement>(null), panel=useRef<HTMLDivElement>(null);
  const firstFocus=useRef<'first'|'last'>('first'), id=useId();
  const close=(restore=false)=>{setOpen(false);setConfirm(false);if(restore)trigger.current?.focus({preventScroll:true});};
  const show=(last=false)=>{firstFocus.current=last?'last':'first';setConfirm(false);setOpen(true);};
  useLayoutEffect(()=>{
    if(!open || !trigger.current || !panel.current)return;
    const anchor=trigger.current.getBoundingClientRect(), bounds=panel.current.getBoundingClientRect();
    setPosition({left:Math.max(8,Math.min(window.innerWidth-bounds.width-8,anchor.right-bounds.width)),
      top:Math.max(8,anchor.bottom+4+bounds.height<=window.innerHeight-8 ? anchor.bottom+4 : anchor.top-bounds.height-4)});
    const buttons=[...panel.current.querySelectorAll<HTMLButtonElement>('button')];
    (confirm?panel.current.querySelector<HTMLButtonElement>('[data-cancel]'):firstFocus.current==='last'?buttons.at(-1):buttons[0])?.focus({preventScroll:true});
  },[open,confirm]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:globalThis.PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))close();};
    const cancel=()=>close();
    const scroll=(event:Event)=>{if(!panel.current?.contains(event.target as Node))close();};
    document.addEventListener('pointerdown',outside);document.addEventListener('scroll',scroll,true);
    window.addEventListener('blur',cancel);window.addEventListener('resize',cancel);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('scroll',scroll,true);window.removeEventListener('blur',cancel);window.removeEventListener('resize',cancel);};
  },[open]);
  const action=(callback:()=>void)=>{close(true);callback();};
  return <>
    <button type="button" ref={trigger} className="gesso-material-menu-trigger" aria-label={`Material options: ${name}`} title="Material options"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined}
      onClick={()=>open?close(true):show()} onKeyDown={event=>{
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();event.stopPropagation();show(event.key==='ArrowUp');}
      }}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
      </svg>
    </button>
    {open&&createPortal(<div ref={panel} id={id} className="gesso-material-menu" style={position}
      role={confirm?'alertdialog':'menu'} aria-label={confirm?`Delete ${name}?`:`Material options: ${name}`} aria-describedby={confirm?`${id}-description`:undefined}
      onBlur={event=>{if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node)&&!trigger.current?.contains(event.relatedTarget as Node))close();}}
      onKeyDown={event=>{
        event.stopPropagation();
        if(event.key==='Escape'){event.preventDefault();close(true);return;}
        if(event.key==='Tab'&&!confirm){close(true);return;}
        const buttons=[...panel.current!.querySelectorAll<HTMLButtonElement>('button')], index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        if(confirm&&event.key==='Tab'){
          if(event.shiftKey&&index===0){event.preventDefault();buttons.at(-1)?.focus();}
          else if(!event.shiftKey&&index===buttons.length-1){event.preventDefault();buttons[0]?.focus();}
          return;
        }
        if(confirm)return;
        const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(index+1)%buttons.length:event.key==='ArrowUp'?(index-1+buttons.length)%buttons.length:undefined;
        if(next!==undefined){event.preventDefault();buttons[next]?.focus();}
        else if(event.key.length===1&&!event.metaKey&&!event.ctrlKey&&!event.altKey){
          const ordered=[...buttons.slice(index+1),...buttons.slice(0,index+1)];
          ordered.find(button=>button.textContent?.toLowerCase().startsWith(event.key.toLowerCase()))?.focus();
        }
      }}>
      {confirm?<>
        <strong>Delete {name}?</strong>
        <p id={`${id}-description`}>{deleteDescription}</p>
        <div className="gesso-material-delete-actions">
          <button type="button" data-cancel onClick={()=>close(true)}>Cancel</button>
          <button type="button" className="is-destructive" onClick={()=>action(onDelete)}>Delete</button>
        </div>
      </>:<>
        <button type="button" role="menuitem" onClick={()=>action(onRename)}>Rename</button>
        <button type="button" role="menuitem" onClick={()=>action(onDuplicate)}>Duplicate</button>
        <button type="button" role="menuitem" onClick={()=>action(onAttach)}>Attach objects</button>
        <div role="separator"/>
        <button type="button" role="menuitem" className="is-destructive" onClick={()=>deleteDescription?setConfirm(true):action(onDelete)}>Delete</button>
      </>}
    </div>,document.body)}
  </>;
}
