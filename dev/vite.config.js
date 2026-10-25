import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WIDGET_SRC = resolve(__dirname, '../frontend/tuberadio.js');

/**
 * Vite plugin that:
 *  - dev:   serves ../frontend/tuberadio.js as /tuberadio.js via dev middleware
 *  - build: copies the file into the output directory
 */
function serveWidgetPlugin() {
  return {
    name: 'serve-widget',

    // Dev server middleware
    configureServer(server) {
      server.middlewares.use('/tuberadio.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(readFileSync(WIDGET_SRC, 'utf-8'));
      });
    },

    // Production build — copy file alongside the bundle
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        resolve(outDir, 'tuberadio.js'),
        readFileSync(WIDGET_SRC, 'utf-8'),
      );
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',

  plugins: [serveWidgetPlugin()],

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/hls': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/archive': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
