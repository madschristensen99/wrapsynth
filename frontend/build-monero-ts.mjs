// Build script: bundles monero-ts into a single browser-compatible file
// Usage: node build-monero-ts.mjs
import esbuild from 'esbuild';
import { copyFileSync } from 'fs';

// Bundle monero-ts for browser
await esbuild.build({
  entryPoints: ['node_modules/monero-ts/dist/index.js'],
  bundle: true,
  format: 'iife',
  globalName: 'monero_ts',
  outfile: 'js/monero-ts.js',
  platform: 'browser',
  target: ['es2020'],
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
  // Node.js built-ins that monero-ts uses but aren't needed in browser
  alias: {
    'http': 'data:text/javascript,export default {}',
    'https': 'data:text/javascript,export default {}',
    'fs': 'data:text/javascript,export default {}',
    'path': 'data:text/javascript,export default {}',
    'os': 'data:text/javascript,export default {}',
    'crypto': 'data:text/javascript,export default {}',
    'assert': 'data:text/javascript,export default function assert(cond,msg){if(!cond)throw new Error(msg||"assertion failed")}',
    'stream': 'data:text/javascript,export default {}',
    'url': 'data:text/javascript,export default {}',
    'worker_threads': 'data:text/javascript,export default {}',
    'child_process': 'data:text/javascript,export default {}',
  },
  logLevel: 'info',
});

// Copy the worker file
try {
  copyFileSync('node_modules/monero-ts/dist/monero.worker.js', 'js/monero.worker.js');
  console.log('✅ Copied monero.worker.js');
} catch (e) {
  console.warn('Could not copy monero.worker.js:', e.message);
}

console.log('✅ Built js/monero-ts.js');
