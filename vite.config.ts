import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Content Security Policy. Notes:
 * - 'unsafe-inline' for styles is needed because React sets inline style attributes (grid areas, bar widths).
 * - blob: is used for object URLs and for the module workers Vite emits.
 * - Google is allowed for sign-in (accounts.google.com) and its APIs (Drive, userinfo, Gemini).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' blob: data: https://*.googleusercontent.com",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://*.googleapis.com https://accounts.google.com",
  'frame-src https://accounts.google.com',
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/** Writes dist/_headers (Netlify and Cloudflare Pages read it; other hosts can copy the values). */
function headersFile(): Plugin {
  return {
    name: 'emit-headers-file',
    apply: 'build',
    generateBundle() {
      const lines = [
        '/*',
        ...Object.entries(SECURITY_HEADERS).map(([k, v]) => `  ${k}: ${v}`),
        '',
        '/assets/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
      ];
      this.emitFile({ type: 'asset', fileName: '_headers', source: lines.join('\n') });
    },
  };
}

export default defineConfig({
  plugins: [react(), headersFile()],
  worker: { format: 'es' },
  server: { port: 5173 },
  preview: { port: 4173, headers: SECURITY_HEADERS },
  optimizeDeps: {
    // Changing this define changes Vite's dependency hash, so browsers refetch the patched ag-psd.
    // Bump it whenever scripts/patch-ag-psd.mjs changes.
    esbuildOptions: { define: { __AG_PSD_PATCH__: '2' } },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
