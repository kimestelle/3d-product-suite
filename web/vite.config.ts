import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({base:process.env.VITE_BASE_PATH || '/',plugins:[react()],server:{proxy:{'/api':{target:'http://127.0.0.1:8787',changeOrigin:true}}},build:{sourcemap:true,assetsInlineLimit:200000,rollupOptions:{input:{editor:fileURLToPath(new URL('./index.html',import.meta.url)),worldComparison:fileURLToPath(new URL('./world-comparison.html',import.meta.url))}}},test:{environment:'node'}} as any);
