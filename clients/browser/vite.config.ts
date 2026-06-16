import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'path';
import dts from 'unplugin-dts/vite';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const __filname = fileURLToPath(import.meta.url);
const __dirname = dirname(__filname);

export default defineConfig({
  plugins: [
    vue(),
    dts({
      entryRoot: resolve(__dirname, 'src'),
      bundleTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'CameraUiClient',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['vue', '@vueuse/core', /^@camera\.ui\/transport/, /^@camera\.ui\/rpc/, /^@camera\.ui\/sdk/],
      output: {
        globals: {
          vue: 'Vue',
          '@vueuse/core': 'VueUse',
        },
      },
    },
    // sourcemap: true,
    minify: false,
  },
  resolve: {
    alias: [
      { find: /^@nats-io\/transport-node$/, replacement: resolve(__dirname, '../../externals/rpc/node/dist/wrapper.js') },
      { find: /^@nats-io\/nats-core$/, replacement: resolve(__dirname, '../../externals/nats.js/core/src/mod.ts') },
      { find: /^@nats-io\/nats-core\/internal$/, replacement: resolve(__dirname, '../../externals/nats.js/core/src/internal_mod.ts') },
      { find: /^@nats-io\/nuid$/, replacement: resolve(__dirname, '../../externals/rpc/node/node_modules/@nats-io/nuid') },
      { find: /^@nats-io\/nkeys$/, replacement: resolve(__dirname, '../../externals/rpc/node/node_modules/@nats-io/nkeys') },
    ],
  },
});
