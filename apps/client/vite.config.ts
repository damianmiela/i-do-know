import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development, Socket.IO, login, the join link and quiz photos go to the Fastify server.
    // Only the server's routes are protected in development; the pages here are not.
    proxy: {
      '/socket.io': { target: 'http://127.0.0.1:3210', ws: true },
      '/login': 'http://127.0.0.1:3210',
      '/logout': 'http://127.0.0.1:3210',
      '/join': 'http://127.0.0.1:3210',
      '/photos/': 'http://127.0.0.1:3210',
      '/host/photos': 'http://127.0.0.1:3210',
      '/host/games/': 'http://127.0.0.1:3210',
    },
  },
});
