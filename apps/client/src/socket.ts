import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, View } from '@idoknow/shared';

const VIEWS: Record<string, View> = { '/play': 'play', '/screen': 'screen', '/host': 'host' };

/** The view this page is, from its path. Undefined on other pages (no socket there). */
export const view: View | undefined = VIEWS[window.location.pathname];

// Connects to the same origin the page was loaded from (Vite proxies it in development).
// The server checks the login / guest cookie and which view this socket is for.
// Not connected yet: each page calls socket.connect() once its listeners are in place, or the
// first state (sent right after connecting) would arrive before anyone listens.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({
  auth: { view },
  autoConnect: false,
});
