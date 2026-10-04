import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { scheduleDemoReset, setEventFlag, startupEnv } from './demo';
import { loadConfig } from './env';
import { createServer } from './server';

// src/ and dist/ both sit two levels below the project root.
const root = resolve(import.meta.dirname, '../../..');

// The public demo plays with a fresh copy of the example content (never the real files), unless
// it was switched to the real event (see demo.ts): then the event's content and password.
for (const [key, value] of Object.entries(startupEnv(process.env, root))) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Settings come from the environment (.env locally via --env-file-if-exists, Docker env in
// production). Missing ADMIN_PASSWORD / SESSION_SECRET or bad content stop the server here.
const config = loadConfig(process.env, root);

let app: FastifyInstance | undefined;
const shutdown = () => {
  // backstop: never hang on shutdown (Docker would kill us anyway after 10 s)
  setTimeout(() => process.exit(1), 5_000).unref();
  void (app?.close() ?? Promise.resolve()).then(() => process.exit(0));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);

try {
  ({ app } = await createServer(config, {
    clientDist: resolve(root, 'apps/client/dist'),
    restart: shutdown, // Docker (restart: unless-stopped) starts it again
  }));
} catch (e) {
  // the event's content broke after the switch: back to the demo at the next start, never a loop
  if (config.event && config.eventDir) setEventFlag(config.eventDir, false);
  throw e;
}

// the nightly reset: the demo ends itself, Docker (restart: unless-stopped) starts it fresh
if (config.demo) scheduleDemoReset(shutdown);

await app.listen({ port: config.port, host: config.host });
