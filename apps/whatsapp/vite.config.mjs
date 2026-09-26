import {defineConfig} from 'vite';

export default defineConfig({
  publicDir: false,
  define: {'process.env.NODE_ENV': '"production"'},
  build: {
    outDir: 'public',
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {entry: 'assistant/assistant.jsx', formats: ['es'], fileName: () => 'assistant-ui.js'},
    rollupOptions: {output: {assetFileNames: () => 'assistant-ui.css'}}
  }
});
