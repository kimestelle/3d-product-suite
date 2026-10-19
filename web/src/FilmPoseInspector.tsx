import {useState} from 'react';
import {NumberControl} from './EditorControls';
import {getPropertyValue, getTrack, writeProperty, propertyPresentation, animationBlockReason, type KeyframeProperty} from './keyframes';
import {listMotions, motionChannels, motionLabel} from './filmMotion';
import {shotAtFrame} from './sequence';

/** Static placement stays available beside bounded motion, with ownership stated per channel. */
export default function FilmPoseInspector({scene,frame,target,onChange,onMotionSelect,disabled=false}:{scene:any;frame:number;target:string;onChange:(edit:(scene:any)=>void)=>void;onMotionSelect:(id:string)=>void;disabled?:boolean}) {
  const [error,setError]=useState('');
  const shot=shotAtFrame(scene,frame);
  const owners=listMotions(scene,shot.id).filter(entry=>entry.motion.enabled&&entry.motion.target===target);
  const properties:KeyframeProperty[]=['position.x','position.y','position.z',...(target==='$product'?[]:['rotation.x','rotation.y','rotation.z'] as KeyframeProperty[]),'scale'];
  const blocked=animationBlockReason(scene,target,'position.x');
  return <div className="gesso-panel film-pose-inspector">
    {blocked&&<p className="gesso-note">{blocked}</p>}
    {(['position','rotation','scale'] as const).map(group=>{
      const fields=properties.filter(property=>property.startsWith(group));if(!fields.length)return null;
      return <section className="gesso-section" key={group} aria-label={`${group} controls`}>
        <div className="gesso-section-heading">{group==='position'?'Position':group==='rotation'?'Rotation':'Scale'}<span>{group==='position'?'mm':group==='rotation'?'°':'%'}</span></div>
        <div className={group==='scale'?'':'gesso-vector-inline gesso-vector-values'}>{fields.map(property=>{
          const owner=owners.find(entry=>motionChannels(entry.motion).includes(property));
          const info=propertyPresentation(scene,target,property);
          const label=info.axis||'Size';
          return <NumberControl key={property} label={label} ariaLabel={`Base ${group}${info.axis?` ${info.axis}`:''}`} value={getPropertyValue(scene,target,property,frame)*info.factor} compact={group!=='scale'}
            min={info.min} max={info.max} step={info.step} unit={info.unit} disabled={disabled||!!owner||!!blocked}
            onChange={value=>{try{onChange(next=>writeProperty(next,target,property,frame,value/info.factor));setError('');}catch(failure){setError(failure instanceof Error?failure.message:'Pose could not be changed.');}}}/>
        })}</div>
      </section>;
    })}
    {!!owners.length&&<div className="film-property-owners">{owners.map(({motion})=><button key={motion.id} type="button" onClick={()=>onMotionSelect(motion.id)}><span>{motionLabel(motion)}</span><small>controls {motion.kind==='mechanical'?'movement':motionChannels(motion).join(', ')}</small></button>)}</div>}
    <p className="gesso-meta">{properties.some(property=>getTrack(scene,target,property)?.enabled)?'Animated values record a key at the current film time.':'Pose values apply throughout the film. Add a motion to change them over time.'}</p>
    {error&&<p className="gesso-error" role="alert">{error}</p>}
  </div>;
}
