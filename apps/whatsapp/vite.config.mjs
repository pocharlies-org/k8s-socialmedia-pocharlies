import {defineConfig} from 'vite';

export default defineConfig({
  publicDir: false,
  define: {'process.env.NODE_ENV': '"production"'},
  build: {
    outDir: 'public',
    emptyOutDir: false,
    cssCodeSplit: false,
    // Keep compiled third-party code distinct from the reviewed assistant source.
    lib: {entry: 'assistant/assistant.jsx', formats: ['es'], fileName: () => 'assistant-ui.generated.js'},
    rollupOptions: {output: {assetFileNames: () => 'assistant-ui.generated.css'}}
  }
});
