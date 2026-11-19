import { defineConfig } from 'vite';

// Cross-origin isolation lets onnxruntime-web use multi-threaded WASM (SharedArrayBuffer).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
