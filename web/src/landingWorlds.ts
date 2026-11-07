import studio from './assets/gesso/landing-worlds/studio.webp?no-inline';
import velvet from './assets/gesso/landing-worlds/velvet.webp?no-inline';
import atrium from './assets/gesso/landing-worlds/atrium.webp?no-inline';

export const landingWorlds=[
  {id:'studio',short:'Studio',name:'Blue studio',src:studio,tone:'#0A2D55',label:'The blue-dial Auden watch in a blue studio'},
  {id:'velvet',short:'Velvet',name:'Velvet curtain',src:velvet,tone:'#28120D',label:'The same blue-dial Auden watch in front of a velvet curtain'},
  {id:'atrium',short:'Atrium',name:'Concrete atrium',src:atrium,tone:'#868074',label:'The same blue-dial Auden watch in a concrete atrium'},
] as const;
