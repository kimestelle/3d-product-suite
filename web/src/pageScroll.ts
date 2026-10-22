/** Retained pages keep their editor state, but enter at their reading start. */
export const PAGE_SCROLL_RESET_EVENT = 'gesso:page-scroll-reset';

export function resetPageScroll(host:HTMLElement|undefined) {
  if(!host)return;
  for(const scrollport of host.querySelectorAll<HTMLElement>('[data-frame-scroll]')) {
    // Cancel any in-flight smooth anchor scroll before measuring the new frame.
    scrollport.scrollTo({top:0,left:0,behavior:'instant'});
    scrollport.dispatchEvent(new Event(PAGE_SCROLL_RESET_EVENT));
  }
}
