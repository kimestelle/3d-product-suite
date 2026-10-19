import {useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {STATIC_MOTION_QUERY} from './motionPolicy';

// Matches the shared cabinet height duration. Content leaves the interaction tree
// immediately; only its closing pixels remain until the space transfer finishes.
const EXIT_MS = 240;
function useExitPresence(open: boolean) {
  const [present, setPresent] = useState(open);
  useLayoutEffect(() => {
    if (open) {setPresent(true); return;}
    const policy = matchMedia(STATIC_MOTION_QUERY);
    if (policy.matches) {setPresent(false); return;}
    const timer = window.setTimeout(() => setPresent(false), EXIT_MS);
    const settle = () => {if (policy.matches) {clearTimeout(timer); setPresent(false);}};
    policy.addEventListener('change', settle);
    return () => {clearTimeout(timer); policy.removeEventListener('change', settle);};
  }, [open]);
  return open || present;
}

export function EditorCabinetBody({open, id, children}: {open:boolean; id:string; children:ReactNode}) {
  const present = useExitPresence(open);
  const body = useRef<HTMLDivElement>(null);
  // Hold the last committed content during exit. In particular, do not relocate
  // an outgoing material editor portal when the newly selected layer changes props.
  const lastContent = useRef(children);
  useLayoutEffect(() => {if (open) lastContent.current = children;}, [open, children]);
  useLayoutEffect(() => {
    if (!open && body.current?.contains(document.activeElement)) {
      body.current.parentElement?.querySelector<HTMLButtonElement>('.gesso-section-toggle')?.focus({preventScroll:true});
    }
  }, [open]);
  if (!present) return null;
  return <div ref={body} id={id} className="gesso-section-body" data-editor-cabinet data-open={open} inert={!open} aria-hidden={!open || undefined}>{open ? children : lastContent.current}</div>;
}

// One mounted surface, even while changing File / Edit / View. The inner element
// keeps its natural size; the outer surface transitions to that measured height.
export function EditorMenu({name, onClose, children}: {name:string|null; onClose:()=>void; children:(name:string)=>ReactNode}) {
  const [retained, setRetained] = useState(name);
  if (name && name !== retained) setRetained(name);
  const shown = name || retained;
  const [height, setHeight] = useState(0);
  const content = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement|null>(null);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const style = surface.current && getComputedStyle(surface.current);
      const border = style ? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) : 0;
      setHeight(element.getBoundingClientRect().height + border);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shown]);
  useLayoutEffect(() => {
    if (name) {
      const trigger = surface.current?.parentElement?.querySelector<HTMLElement>(name === 'History' ? 'button[aria-label="History"]' : `.gesso-appmenus button[aria-expanded="true"]`);
      returnTo.current = trigger ?? null;
    } else if (surface.current?.contains(document.activeElement)) {
      returnTo.current?.focus({preventScroll:true});
    }
  }, [name]);
  if (!shown) return null;
  return <div ref={surface} className={`gesso-menu gesso-motion-menu ${shown==='History'?'gesso-menu-right':''}`} data-open={!!name}
    onKeyDown={event => {if (event.key === 'Escape' && !event.defaultPrevented) {event.preventDefault(); event.stopPropagation(); returnTo.current?.focus({preventScroll:true}); onClose();}}}
    aria-label={`${shown} options`} aria-hidden={!name || undefined} inert={!name} style={{height:name ? height : 0}}>
    <div ref={content} className="gesso-menu-content" key={shown}>{children(shown)}</div>
  </div>;
}
