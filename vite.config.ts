import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`         → dist/ (multi-file; used by GitHub Pages)
// `npm run build:single`  → dist-single/index.html (one self-contained file)
// BASE_PATH sets the public path, e.g. "/province-forge/" for GitHub Pages.
export default defineConfig(({ mode }) => ({
  base: process.env.BASE_PATH ?? '/',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    target: 'es2022',
    // demo.html = demo game client (React + MapView + baked tiles), see tools/make-demo.ts
    rollupOptions: mode === 'single' ? undefined : { input: { main: 'index.html', demo: 'demo.html' } },
  },
}));
