import {useEffect,useId,useRef,useState,type RefObject} from 'react';
import {PART_NAME_LIMIT} from './hierarchy';

/** Commit a name as one scene edit, rather than one undo step per character. */
export default function PartNameField({name,inputRef,onCommit}:{name:string;inputRef:RefObject<HTMLInputElement|null>;onCommit:(name:string)=>void}) {
  const id=useId(),[draft,setDraft]=useState(name),[error,setError]=useState('');
  const cancelBlur=useRef(false);
  useEffect(()=>{setDraft(name);setError('');},[name]);
  const commit=()=>{
    if(cancelBlur.current){cancelBlur.current=false;return;}
    const next=draft.trim();
    if(!next){setDraft(name);setError('Enter an object name.');return;}
    if(next===name){setDraft(name);setError('');return;}
    try{onCommit(next);setDraft(next);setError('');}
    catch(reason){setError(reason instanceof Error?reason.message:'Could not rename this object.');}
  };
  return <div className="gesso-part-name-editor">
    <label className="gesso-field" htmlFor={id}><span>Object</span>
      <input ref={inputRef} id={id} aria-label="Object name" maxLength={PART_NAME_LIMIT} value={draft}
        aria-invalid={error?true:undefined} aria-describedby={error?`${id}-error`:undefined}
        autoComplete="off" spellCheck={false} onChange={event=>{setDraft(event.target.value);setError('');}}
        onBlur={commit} onKeyDown={event=>{
          if(event.nativeEvent.isComposing)return;
          if(event.key==='Enter'){event.preventDefault();event.stopPropagation();event.currentTarget.blur();}
          if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelBlur.current=true;setDraft(name);setError('');event.currentTarget.blur();}
        }}/>
    </label>
    {error&&<p id={`${id}-error`} className="gesso-error" role="alert">{error}</p>}
  </div>;
}
