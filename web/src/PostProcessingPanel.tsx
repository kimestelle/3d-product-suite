import {useEffect,useRef,useState} from 'react';
import {NumberControl} from './EditorControls';
import {POST_PROCESSING_LIMITS,resolvePostProcessing,suggestAutoBalance,type PostProcessingAnalysis,type PostProcessingNumber,type PostProcessingSettings} from './postProcessing';
import './post-processing.css';

export interface PostProcessingPanelProps {
  scene:any;
  onChange:(edit:(scene:any)=>void)=>void|boolean;
  analyzePostProcessing?:()=>Promise<PostProcessingAnalysis>;
  ready?:boolean;
}
const colorControls:Array<{key:PostProcessingNumber;label:string;factor?:number;unit?:string}>=[
  {key:'exposureEV',label:'Exposure',unit:'EV'},{key:'temperature',label:'Warmth',factor:100},{key:'tint',label:'Tint',factor:100},
  {key:'contrast',label:'Contrast',factor:100,unit:'%'},{key:'saturation',label:'Saturation',factor:100,unit:'%'},
  {key:'highlights',label:'Highlights',factor:100},{key:'shadows',label:'Shadows',factor:100},
];
export default function PostProcessingPanel({scene,onChange,analyzePostProcessing,ready=true}:PostProcessingPanelProps) {
  const settings=resolvePostProcessing(scene.postProcessing),[analyzing,setAnalyzing]=useState(false),[error,setError]=useState('');
  const request=useRef(0),currentScene=useRef(scene);currentScene.current=scene;
  useEffect(()=>{request.current++;setAnalyzing(false);setError('');return()=>{request.current++;};},[scene]);
  const update=(edit:(settings:PostProcessingSettings)=>void)=>onChange(next=>{const value=resolvePostProcessing(next.postProcessing);edit(value);next.postProcessing=value;});
  const autoBalance=async()=>{
    if(!analyzePostProcessing||!ready||analyzing)return;
    const id=++request.current,source=scene;setAnalyzing(true);setError('');
    try{
      const analysis=await analyzePostProcessing();
      if(id!==request.current||currentScene.current!==source)return;
      const balanced=suggestAutoBalance(analysis,source.postProcessing);
      onChange(next=>{next.postProcessing=balanced;});
    }catch(reason){if(id===request.current)setError(reason instanceof Error?reason.message:'The preview could not be measured.');}
    finally{if(id===request.current)setAnalyzing(false);}
  };
  const numberControl=({key,label,factor=1,unit}:{key:PostProcessingNumber;label:string;factor?:number;unit?:string})=>{
    const [min,max]=POST_PROCESSING_LIMITS[key];
    return <NumberControl key={key} label={label} ariaLabel={`Image ${label.toLowerCase()}`} unit={unit} value={settings[key]*factor}
      min={min*factor} max={max*factor} step={factor===100?1:.05} precision={factor===100?0:2} disabled={!ready||!settings.enabled||analyzing}
      onChange={value=>update(next=>{next[key]=value/factor;})}/>;
  };
  return <section className="gesso-section gesso-post-processing" aria-label="Post-processing">
    <div className="gesso-section-heading"><span className="gesso-section-label">Post-processing</span>
      <label className="gesso-check"><input type="checkbox" aria-label="Enable post-processing" checked={settings.enabled} disabled={!ready||analyzing}
        onChange={event=>{const enabled=event.target.checked;update(next=>{next.enabled=enabled;});}}/><span>On</span></label>
    </div>
    <div className="gesso-button-row">
      <button type="button" disabled={!ready||analyzing||!analyzePostProcessing} title={!analyzePostProcessing?'Open a loaded scene preview to balance its image.':undefined} onClick={()=>{void autoBalance();}}>{analyzing?'Measuring…':'Auto balance'}</button>
      <button type="button" disabled={!ready||analyzing||!scene.postProcessing} onClick={()=>onChange(next=>{delete next.postProcessing;})}>Reset</button>
    </div>
    <p className="gesso-meta gesso-note">Grades 3D scenes in Stage, Film and export. Auto balance measures this view once; settings stay fixed through the film. Switch off to compare.</p>
    {colorControls.map(numberControl)}
    <details className="gesso-disclosure gesso-post-effects"><summary>Effects</summary><div>
      {[{key:'bloom' as const,label:'Glow',factor:100,unit:'%'},{key:'vignette' as const,label:'Vignette',factor:100,unit:'%'},{key:'grain' as const,label:'Grain',factor:100,unit:'%'}].map(numberControl)}
    </div></details>
    {error&&<p className="gesso-control-error" role="alert">{error}</p>}
  </section>;
}
