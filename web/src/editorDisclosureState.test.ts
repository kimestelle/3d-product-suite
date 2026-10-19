import {describe, expect, it, vi} from 'vitest';
import {syncEditorDisclosureState} from './editorDisclosureState';

class ElementStub {
  attributes = new Set<string>();
  children: ElementStub[] = [];
  ownerDocument: {activeElement: ElementStub | null};
  open = false;
  focus;
  constructor(readonly tagName: string, document: {activeElement: ElementStub | null} = {activeElement:null}) {
    this.ownerDocument = document;
    this.focus = vi.fn((_options?: FocusOptions) => {document.activeElement = this;});
  }
  contains(target: ElementStub): boolean {return target === this || this.children.some(child => child.contains(target));}
  hasAttribute(name: string) {return this.attributes.has(name);}
  setAttribute(name: string, _value: string) {this.attributes.add(name);}
  removeAttribute(name: string) {this.attributes.delete(name);}
}
function fixture() {
  const doc: {activeElement: ElementStub | null} = {activeElement:null};
  const details = new ElementStub('DETAILS', doc), summary = new ElementStub('SUMMARY', doc);
  const body = new ElementStub('DIV', doc), control = new ElementStub('INPUT', doc);
  body.children = [control]; details.children = [summary, body];
  const sync = () => syncEditorDisclosureState(details as unknown as HTMLDetailsElement);
  return {doc, details, summary, body, control, sync};
}

describe('Editor native disclosure interaction state', () => {
  it('disables closing controls immediately and returns their focus to the summary without scrolling', () => {
    const f = fixture(); f.doc.activeElement = f.control;
    const setInert = vi.spyOn(f.body, 'setAttribute').mockImplementation(name => {
      expect(f.doc.activeElement).toBe(f.summary);
      f.body.attributes.add(name);
    });
    f.sync();
    expect(setInert).toHaveBeenCalledWith('inert', '');
    expect(f.summary.focus).toHaveBeenCalledWith({preventScroll:true});
    expect(f.summary.hasAttribute('inert')).toBe(false);
  });

  it('restores only flags it owns, including across repeated close events and reopening', () => {
    const f = fixture(), blocked = new ElementStub('FIELDSET', f.doc);
    blocked.setAttribute('inert', ''); f.details.children.push(blocked);
    f.sync(); f.sync();
    expect(f.body.hasAttribute('inert')).toBe(true);
    f.details.open = true; f.sync(); f.sync();
    expect(f.body.hasAttribute('inert')).toBe(false);
    expect(blocked.hasAttribute('inert')).toBe(true);
    f.details.open = false; f.sync(); f.details.open = true; f.sync();
    expect(f.body.hasAttribute('inert')).toBe(false);
    expect(blocked.hasAttribute('inert')).toBe(true);
  });

  it('does not steal focus from another control or the summary', () => {
    const f = fixture();
    f.doc.activeElement = new ElementStub('BUTTON', f.doc); f.sync();
    f.doc.activeElement = f.summary; f.sync();
    expect(f.summary.focus).not.toHaveBeenCalled();
  });

  it('keeps independently closed nested disclosures inert after the outer disclosure reopens', () => {
    const f = fixture(), nested = new ElementStub('DETAILS', f.doc);
    const nestedSummary = new ElementStub('SUMMARY', f.doc), nestedBody = new ElementStub('DIV', f.doc);
    nested.children = [nestedSummary, nestedBody]; f.body.children.push(nested);
    syncEditorDisclosureState(nested as unknown as HTMLDetailsElement);
    f.sync(); f.details.open = true; f.sync();
    expect(f.body.hasAttribute('inert')).toBe(false);
    expect(nestedBody.hasAttribute('inert')).toBe(true);
    nested.open = true; syncEditorDisclosureState(nested as unknown as HTMLDetailsElement);
    expect(nestedBody.hasAttribute('inert')).toBe(false);
  });

  it('releases its own flag when a body moves elsewhere and notices a new closing body', () => {
    const f = fixture(); f.sync();
    const replacement = new ElementStub('SECTION', f.doc);
    f.details.children = [f.summary, replacement]; f.sync();
    expect(f.body.hasAttribute('inert')).toBe(false);
    expect(replacement.hasAttribute('inert')).toBe(true);
    f.details.open = true; f.sync();
    expect(replacement.hasAttribute('inert')).toBe(false);
  });
});
