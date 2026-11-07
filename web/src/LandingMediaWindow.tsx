import type {HTMLAttributes} from 'react';
import {FrameWindow} from './DynamicFrame';

// Each specimen retains its native geometry. Only the specimen in view
// lends its window to the page transition; the others remain ordinary media.
export function LandingMediaWindow(props:HTMLAttributes<HTMLDivElement>) {
  return <FrameWindow {...props} data-landing-frame=""/>;
}
