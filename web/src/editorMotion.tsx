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
  const [left, setLeft] = useState<number>();
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
  useLayoutEffect(() => {
    const popup = surface.current, parent = popup?.parentElement;
    if (!name || !popup || !parent) return;
    const trigger = parent.querySelector<HTMLElement>(name === 'History' ? 'button[aria-label="History"]' : '.gesso-appmenus button[aria-expanded="true"]');
    if (!trigger) return;
    const position = () => {
      const anchor = trigger.getBoundingClientRect(), bounds = popup.getBoundingClientRect();
      const triggerStyle = getComputedStyle(trigger), popupStyle = getComputedStyle(popup);
      const px = (value: string) => parseFloat(value) || 0;
      const inset = px(popupStyle.getPropertyValue('--gesso-menu-inset')) || 12;
      let desired = anchor.left + px(triggerStyle.borderLeftWidth) + px(triggerStyle.paddingLeft)
        - inset - px(popupStyle.borderLeftWidth);
      if (name === 'History') {
        const parentStyle = getComputedStyle(parent);
        desired = parent.getBoundingClientRect().right - px(parentStyle.borderRightWidth) - px(parentStyle.paddingRight) - bounds.width;
      }
      const viewportLeft = Math.max(8, Math.min(window.innerWidth - bounds.width - 8, desired));
      // CSS left is relative to the positioned header, whereas trigger bounds are viewport coordinates.
      const containing = popup.offsetParent as HTMLElement | null;
      const origin = containing ? containing.getBoundingClientRect().left + containing.clientLeft - containing.scrollLeft : -window.scrollX;
      setLeft(viewportLeft - origin);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(trigger); observer.observe(parent);
    window.addEventListener('resize', position);
    return () => {observer.disconnect(); window.removeEventListener('resize', position);};
  }, [name]);
  if (!shown) return null;
  return <div ref={surface} className={`gesso-menu gesso-motion-menu ${shown==='History'?'gesso-menu-right':''}`} data-open={!!name}
    onKeyDown={event => {if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      // Let the native picker dismiss before dismissing the menu around it.
      if ((event.target as Element).closest('select:open')) return;
      event.preventDefault(); returnTo.current?.focus({preventScroll:true}); onClose();
    }}}
    aria-label={`${shown} options`} aria-hidden={!name || undefined} inert={!name} style={{height:name ? height : 0,left,right:left === undefined ? undefined : 'auto'}}>
    <div ref={content} className="gesso-menu-content" key={shown}>{children(shown)}</div>
  </div>;
}
