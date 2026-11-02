import {describe,it,expect} from 'vitest';
import {startupProjectId} from './startupProject';
describe('studio opening project',()=>{
  const projects=[{id:'lamp',name:'Nessino'},{id:'watch',name:'Auden watch'}];
  it('opens the watch even when a different project was remembered',()=>expect(startupProjectId(projects,'lamp','lamp')).toBe('watch'));
  it('preserves remembered work in a workspace without the watch',()=>expect(startupProjectId(projects.slice(0,1),'fixture','lamp')).toBe('lamp'));
  it('falls back safely when a remembered project has been removed',()=>expect(startupProjectId([],'fixture','removed')).toBe('fixture'));
});
