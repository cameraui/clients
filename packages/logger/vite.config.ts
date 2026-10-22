import { resolve } from 'node:path';
import dts from 'unplugin-dts/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: resolve(import.meta.dirname, 'tsconfig.json'),
      entryRoot: resolve(import.meta.dirname, 'src'),
      exclude: ['**/__tests__/**', '**/*.spec.ts'],
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        worker: resolve(import.meta.dirname, 'src/worker.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        preserveModules: false,
      },
    },
    minify: false,
  },
});
