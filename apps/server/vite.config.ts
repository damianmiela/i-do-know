import { defineConfig } from 'vite';

// Builds the server into dist/index.js. npm packages stay external (installed at runtime);
// the workspace package @idoknow/shared is bundled in because it is TypeScript source.
export default defineConfig({
  build: {
    ssr: 'src/index.ts',
    outDir: 'dist',
    target: 'node24',
  },
});
