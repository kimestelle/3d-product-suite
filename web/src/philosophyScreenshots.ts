import principles from './assets/gesso/editor-stills/principles.webp?no-inline';
import result from './assets/gesso/editor-stills/result.webp?no-inline';
import product from './assets/gesso/editor-stills/product.webp?no-inline';
import interfaceView from './assets/gesso/editor-stills/interface.webp?no-inline';
import person from './assets/gesso/editor-stills/person.webp?no-inline';

export const PHILOSOPHY_SCREENSHOTS = [
  {stage:1,id:'principles',src:principles,width:1512,height:1512,position:'center center',alignment:'xMidYMid'},
  {stage:2,id:'result',src:result,width:1512,height:1512,position:'center center',alignment:'xMidYMid'},
  {stage:3,id:'product',src:product,width:1220,height:1632,position:'center center',alignment:'xMidYMid'},
  {stage:4,id:'interface',src:interfaceView,width:1512,height:994,position:'center center',alignment:'xMidYMid'},
  {stage:5,id:'person',src:person,width:1512,height:1065,position:'center center',alignment:'xMidYMid'},
] as const;
