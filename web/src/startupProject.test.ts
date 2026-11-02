import {describe,it,expect} from 'vitest';
import {startupProjectId} from './startupProject';
describe('studio opening project',()=>{
  const projects=[{id:'lamp',name:'Nessino'},{id:'camera',name:'Leica look-alike camera'}];
  it('opens the camera even when a different project was remembered',()=>expect(startupProjectId(projects,'lamp','lamp')).toBe('camera'));
  it('preserves remembered work in a workspace without the camera',()=>expect(startupProjectId(projects.slice(0,1),'fixture','lamp')).toBe('lamp'));
  it('falls back safely when a remembered project has been removed',()=>expect(startupProjectId([],'fixture','removed')).toBe('fixture'));
});
