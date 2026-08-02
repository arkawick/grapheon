import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
