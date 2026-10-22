// Cycles stills from the showcase campaigns, rendered at each aperture's aspect (D161).
// The Figma interface compositions (D158) stay in editor-stills/ for reference.
import principles from './assets/gesso/form-light-renders/omega-speedmaster.webp?no-inline';
import result from './assets/gesso/form-light-renders/sasha-ring.webp?no-inline';
import product from './assets/gesso/form-light-renders/ambre-perfume.webp?no-inline';
import interfaceView from './assets/gesso/form-light-renders/leica-camera.webp?no-inline';
import person from './assets/gesso/form-light-renders/theo-teapot.webp?no-inline';

export const PHILOSOPHY_SCREENSHOTS = [
  {stage:1,id:'principles',src:principles,width:1512,height:1512,position:'center center',alignment:'xMidYMid'},
  {stage:2,id:'result',src:result,width:1512,height:1512,position:'center center',alignment:'xMidYMid'},
  {stage:3,id:'product',src:product,width:1220,height:1632,position:'center center',alignment:'xMidYMid'},
  {stage:4,id:'interface',src:interfaceView,width:1512,height:994,position:'center center',alignment:'xMidYMid'},
  {stage:5,id:'person',src:person,width:1512,height:1066,position:'center center',alignment:'xMidYMid'},
] as const;
