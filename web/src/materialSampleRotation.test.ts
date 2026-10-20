import {describe,expect,it} from 'vitest';
import {Quaternion,Vector3} from 'three';
import {rotateMaterialSample} from './materialSampleRotation';

describe('material specimen rotation',()=>{
  it('follows the pointer in screen axes at either preview size',()=>{
    for(const size of [144,184]){
      const horizontal=new Quaternion(),vertical=new Quaternion();
      rotateMaterialSample(horizontal,size/2,0,size);
      rotateMaterialSample(vertical,0,size/2,size);
      expect(new Vector3(0,0,1).applyQuaternion(horizontal).distanceTo(new Vector3(1,0,0))).toBeLessThan(1e-10);
      expect(new Vector3(0,0,1).applyQuaternion(vertical).distanceTo(new Vector3(0,-1,0))).toBeLessThan(1e-10);
    }
  });
  it('can inspect every side without a pole clamp or accumulated scale',()=>{
    const q=new Quaternion();
    rotateMaterialSample(q,184,0,184);
    expect(new Vector3(0,0,1).applyQuaternion(q).z).toBeCloseTo(-1);
    rotateMaterialSample(q,-184,0,184);
    expect(q.angleTo(new Quaternion())).toBeCloseTo(0);
    for(let i=0;i<10000;i++)rotateMaterialSample(q,Math.sin(i)*4,Math.cos(i)*3,184);
    expect(q.length()).toBeCloseTo(1,12);
  });
  it('ignores unusable bounds and does not change a stored cancellation pose',()=>{
    const q=new Quaternion(),before=q.clone();
    for(const size of [0,-1,NaN,Infinity])rotateMaterialSample(q,10,10,size);
    rotateMaterialSample(q,NaN,0,184);
    expect(q.equals(before)).toBe(true);
    rotateMaterialSample(q,20,30,184);
    expect(before.equals(new Quaternion())).toBe(true);
    expect(q.angleTo(before)).toBeGreaterThan(0);
  });
});
