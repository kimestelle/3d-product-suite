import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './compact-panels.css';
import './condensed-editor.css';
import './keyframe-editor.css';
import './interface-system.css';
import './editor-controls.css';
import './film-viewport-controls.css';
import { loadStudioFonts, loadInterfaceFonts } from './fonts';
Promise.all([loadStudioFonts(), loadInterfaceFonts()]).catch(error => console.warn(error)).then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
});
