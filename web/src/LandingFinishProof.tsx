import {useId, useState} from 'react';
import {LandingMediaWindow} from './LandingMediaWindow';
import blueImage from './assets/gesso/landing-finish/auden-dial-blue.webp?no-inline';
import greenImage from './assets/gesso/landing-finish/auden-dial-green.webp?no-inline';
import './landing-finish-proof.css';

// Native AUDEN dial edit from the Option A handoff. Both photographs use
// x:480, y:236, width:1120, height:840 of the original 2370 × 1333 capture.
// The CSS window takes the same x:300, y:180, 560 × 420 crop from each
// photograph. The case and crown provide stable references for the dial edit.
const finishes = [
  {id:'blue', label:'Blue', colour:'#3C4A66', image:blueImage},
  {id:'green', label:'Green', colour:'#234C3C', image:greenImage},
] as const;
type Finish = typeof finishes[number]['id'];

export default function LandingFinishProof({finish,controls=true}:{finish?:Finish;controls?:boolean}) {
  const group = useId();
  const [selected, setSelected] = useState<Finish>('blue');
  const [failed, setFailed] = useState<Partial<Record<Finish, boolean>>>({});
  const finishSelection=finish ?? selected;
  const displayed = finishes.find(finish => finish.id === (finishSelection) && !failed[finish.id])
    ?? (finish ? undefined : finishes.find(item => !failed[item.id]));

  return <figure className="landing-finish-proof">
    <LandingMediaWindow className="landing-finish-proof__stage">
      {finishes.map(finish => <img key={finish.id} src={finish.image} width="1120" height="840"
        loading="lazy" decoding="async" aria-hidden={displayed?.id !== finish.id}
        alt={displayed?.id === finish.id ? `Close view of the Auden ${finish.id} dial, with its silver case and crown` : ''}
        onError={() => setFailed(previous => ({...previous, [finish.id]:true}))}/>)}
      {!displayed && <p role="status">{finish ? 'This dial image could not load.' : 'The watch images could not load.'}</p>}
    </LandingMediaWindow>
    {controls && <fieldset className="landing-finish-proof__controls">
      <legend>Dial finish</legend>
      <div className="landing-finish-proof__choices">
        {finishes.map(finish => <label key={finish.id}>
          <input type="radio" name={group} value={finish.id} checked={displayed?.id === finish.id}
            disabled={failed[finish.id]} onChange={() => setSelected(finish.id)}/>
          <span>
            <i aria-hidden="true" style={{backgroundColor:finish.colour}}/>
            {finish.label}{failed[finish.id] ? ' unavailable' : ''}
          </span>
        </label>)}
      </div>
    </fieldset>}
  </figure>;
}
