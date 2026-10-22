import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import dts from 'unplugin-dts/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    vue(),
    dts({
      entryRoot: resolve(import.meta.dirname, 'src'),
      exclude: ['**/__tests__/**', '**/*.spec.ts'],
      bundleTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'CameraUiClient',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['vue', '@vueuse/core', /^@camera\.ui\/logger/, /^@camera\.ui\/transport/, /^@camera\.ui\/rpc/, /^@camera\.ui\/sdk/],
      output: {
        globals: {
          vue: 'Vue',
          '@vueuse/core': 'VueUse',
        },
      },
    },
    minify: false,
  },
  resolve: {
    alias: [
      { find: /^@nats-io\/transport-node$/, replacement: resolve(import.meta.dirname, '../../node_modules/@camera.ui/rpc/dist/browser.js') },
      { find: /^@nats-io\/nats-core$/, replacement: resolve(import.meta.dirname, '../../node_modules/@camera.ui/rpc/externals/nats.js/core/src/mod.ts') },
      {
        find: /^@nats-io\/nats-core\/internal$/,
        replacement: resolve(import.meta.dirname, '../../node_modules/@camera.ui/rpc/externals/nats.js/core/src/internal_mod.ts'),
      },
    ],
  },
});
