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
  resolve: {
    alias: [
      { find: /^@nats-io\/transport-node$/, replacement: resolve(import.meta.dirname, '../../node_modules/@camera.ui/rpc/dist/wrapper.js') },
      { find: /^@nats-io\/nats-core$/, replacement: resolve(import.meta.dirname, '../../node_modules/@camera.ui/rpc/externals/nats.js/core/src/mod.ts') },
      {
        find: /^@nats-io\/nats-core\/internal$/,
        replacement: resolve(import.meta.dirname, '../../node_modules/@camera.ui/rpc/externals/nats.js/core/src/internal_mod.ts'),
      },
      { find: /^@nats-io\/nuid$/, replacement: resolve(import.meta.dirname, '../../node_modules/@nats-io/nuid') },
      { find: /^@nats-io\/nkeys$/, replacement: resolve(import.meta.dirname, '../../node_modules/@nats-io/nkeys') },
    ],
  },
  build: {
    lib: {
      entry: {
        index: resolve(import.meta.dirname, 'src/index.ts'),
        'transports/http': resolve(import.meta.dirname, 'src/transports/http.ts'),
        'transports/socketio': resolve(import.meta.dirname, 'src/transports/socketio.ts'),
        'transports/nats': resolve(import.meta.dirname, 'src/transports/nats.ts'),
        'transports/ws': resolve(import.meta.dirname, 'src/transports/ws.ts'),
        'transports/nativeHttp': resolve(import.meta.dirname, 'src/transports/nativeHttp.ts'),
        worker: resolve(import.meta.dirname, 'src/worker/index.ts'),
        testing: resolve(import.meta.dirname, 'src/testing/index.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['axios', 'socket.io-client', /^@camera\.ui\//],
      output: {
        preserveModules: false,
      },
    },
    minify: false,
  },
});
