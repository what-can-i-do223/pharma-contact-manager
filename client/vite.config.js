// Vite config — the only non-default setting is the dev proxy.
//
// The proxy forwards any /api/* request from the Vite dev server (port 5173)
// to the Express API (port 3001). The browser therefore only ever talks to
// ONE origin, which is why the server needs no CORS middleware — a decision
// noted back in Phase 2. In a real deployment the built client would be
// served by (or beside) the API under the same origin, preserving the setup.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      // Phase 7: the OAuth kickoff and session endpoints. The browser
      // navigates to /auth/google on OUR origin; the proxy hands it to
      // Express, which redirects on to Google.
      '/auth': 'http://localhost:3001',
    },
  },
});
