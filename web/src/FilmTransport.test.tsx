import React, {type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {FilmTransport} from './FilmTransport';

const base={playing:false,atStart:false,atEnd:false,onPlay:()=>{},onStart:()=>{},onEnd:()=>{}};
function controls(props=base){return React.Children.toArray(FilmTransport(props).props.children) as ReactElement<any>[];}

describe('Film transport',()=>{
  it('uses the supplied playback and seek callbacks without another clock',()=>{
    const onPlay=vi.fn(),onStart=vi.fn(),onEnd=vi.fn();
    const buttons=controls({...base,onPlay,onStart,onEnd});
    buttons[0].props.onClick();buttons[1].props.onClick();buttons[2].props.onClick();
    expect(onStart).toHaveBeenCalledOnce();expect(onPlay).toHaveBeenCalledOnce();expect(onEnd).toHaveBeenCalledOnce();
  });
  it('keeps start/end available during playback so seeking can pause it',()=>{
    expect(controls({...base,atStart:true})[0].props.disabled).toBe(true);
    expect(controls({...base,atStart:true,playing:true})[0].props.disabled).toBe(false);
    expect(controls({...base,atEnd:true})[2].props.disabled).toBe(true);
    expect(controls({...base,atEnd:true,playing:true})[2].props.disabled).toBe(false);
  });
  it('exposes accessible names and keeps activation keys out of viewport shortcuts',()=>{
    const tree=FilmTransport({...base,playing:true}),stopPropagation=vi.fn();
    tree.props.onKeyDown({key:' ',stopPropagation});
    tree.props.onKeyDown({key:'Enter',stopPropagation});
    expect(stopPropagation).toHaveBeenCalledTimes(2);
    const html=renderToStaticMarkup(tree);
    expect(html).toContain('aria-label="Pause film"');
    expect(html).toContain('aria-pressed="true"');
    expect(renderToStaticMarkup(<FilmTransport {...base} context="export preview"/>)).toContain('aria-label="Play export preview"');
    expect(renderToStaticMarkup(<FilmTransport {...base} disabled/>).match(/disabled=""/g)).toHaveLength(3);
  });
});
