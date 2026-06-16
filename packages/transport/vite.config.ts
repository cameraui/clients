import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dts from 'unplugin-dts/vite';
import { defineConfig } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  plugins: [
    dts({
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
      entryRoot: resolve(__dirname, 'src'),
      exclude: ['**/__tests__/**', '**/*.spec.ts'],
    }),
  ],
  resolve: {
    alias: [
      { find: /^@nats-io\/transport-node$/, replacement: resolve(__dirname, '../../externals/rpc/node/dist/wrapper.js') },
      { find: /^@nats-io\/nats-core$/, replacement: resolve(__dirname, '../../externals/nats.js/core/src/mod.ts') },
      { find: /^@nats-io\/nats-core\/internal$/, replacement: resolve(__dirname, '../../externals/nats.js/core/src/internal_mod.ts') },
      { find: /^@nats-io\/nuid$/, replacement: resolve(__dirname, '../../externals/rpc/node/node_modules/@nats-io/nuid') },
      { find: /^@nats-io\/nkeys$/, replacement: resolve(__dirname, '../../externals/rpc/node/node_modules/@nats-io/nkeys') },
    ],
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        'transports/http': resolve(__dirname, 'src/transports/http.ts'),
        'transports/socketio': resolve(__dirname, 'src/transports/socketio.ts'),
        'transports/nats': resolve(__dirname, 'src/transports/nats.ts'),
        'transports/ws': resolve(__dirname, 'src/transports/ws.ts'),
        'transports/nativeHttp': resolve(__dirname, 'src/transports/nativeHttp.ts'),
        worker: resolve(__dirname, 'src/worker/index.ts'),
        testing: resolve(__dirname, 'src/testing/index.ts'),
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
