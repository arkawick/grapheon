import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site from a SUBPATH (/grapheon/), where an
  // absolute /data/... resolves to the domain root and 404s. Set at build time
  // rather than hardcoded so local dev, Docker and a root deploy stay at '/'.
  base: process.env.GRAPHEON_BASE || '/',
  // The extract worker is a module worker with imports of its own; Vite's
  // default worker format (iife) cannot code-split that.
  worker: { format: 'es' },
  server: {
    port: 5180,
    fs: {
      // The worker imports ../../extract and ../../pipeline source directly —
      // one implementation, no copies. Vite must be allowed to serve them.
      allow: ['..'],
    },
  },
});
