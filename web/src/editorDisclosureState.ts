// Closing pixels may remain visible during the native details transition, but
// their controls leave the interaction/accessibility tree at the toggle event.
const ownedInert = new WeakMap<HTMLDetailsElement, Set<Element>>();

export function syncEditorDisclosureState(details: HTMLDetailsElement): void {
  const owned = ownedInert.get(details) ?? new Set<Element>();
  if (details.open) {
    for (const child of owned) child.removeAttribute('inert');
    ownedInert.delete(details);
    return;
  }

  const children = Array.from(details.children);
  const body = children.filter(child => child.tagName.toLowerCase() !== 'summary');
  const active = details.ownerDocument.activeElement;
  if (active && body.some(child => child.contains(active))) {
    (children.find(child => child.tagName.toLowerCase() === 'summary') as HTMLElement | undefined)?.focus({preventScroll:true});
  }

  // A body moved out of this disclosure must not retain a flag we applied.
  for (const child of owned) {
    if (!body.includes(child)) {child.removeAttribute('inert'); owned.delete(child);}
  }
  for (const child of body) {
    if (!child.hasAttribute('inert')) {
      child.setAttribute('inert', '');
      owned.add(child);
    }
  }
  if (owned.size) ownedInert.set(details, owned);
  else ownedInert.delete(details);
}
