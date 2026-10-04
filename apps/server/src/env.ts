// Parsing of environment settings (kept apart from index.ts so it can be tested).
import { resolve } from 'node:path';

/**
 * Only behind a reverse proxy (Caddy): trust its X-Forwarded-For so request.ip is the guest's IP.
 * Unset/"false" = trust nothing (otherwise clients could fake their IP). "true" = trust all,
 * anything else = proxy IP(s)/CIDR, comma-separated. A bare number is refused: Fastify would
 * silently read it as an address, not a hop count.
 */
export function parseTrustProxy(value: string | undefined): boolean | string {
  const v = value?.trim() ?? '';
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) throw new Error(`TRUST_PROXY=${v}: use true or the proxy's IP address`);
  return v;
}

export interface Config {
  port: number;
  host: string;
  trustProxy: boolean | string;
  adminPassword: string;
  sessionSecret: string;
  /** Snapshots go here. */
  dataDir: string;
  /** questions.json, guests.json, photos/. */
  contentDir: string;
  /**
   * Public demo (DEMO_MODE=true): the example content in a fresh temp folder at every start, a
   * daily restart, demo players, no photo uploads, the password shown on the login page.
   */
  demo?: boolean;
  /**
   * The demo's switch to the real event: logging in with this password restarts the server with
   * the real content in `eventDir` (see demo.ts). Only used together with DEMO_MODE.
   */
  eventPassword?: string;
  /** The real event's files: content/ (questions, guests, event, photos), data/, the mode flag. */
  eventDir?: string;
  /** This process plays the real event (switched from the demo). */
  event?: boolean;
}

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;

/**
 * Reads and checks all settings. Throws (so the server refuses to start) when the admin password
 * or the session secret is missing or too short. Relative paths are resolved against `root`.
 */
export function loadConfig(env: Record<string, string | undefined>, root: string): Config {
  const problems: string[] = [];
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (adminPassword.length < MIN_PASSWORD_LENGTH) {
    problems.push(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (sessionSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} random characters`);
  }
  // empty values count as unset (PORT= would otherwise mean "any free port")
  const eventPassword = env.EVENT_PASSWORD ?? '';
  if (eventPassword && eventPassword.length < MIN_PASSWORD_LENGTH) {
    problems.push(`EVENT_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (eventPassword && eventPassword === adminPassword) {
    problems.push(
      'EVENT_PASSWORD must not be the same as ADMIN_PASSWORD (the public demo password)',
    );
  }
  const port = Number(env.PORT || 3210); // not 3000: VS Code often holds it
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT is not a port');
  let trustProxy: boolean | string = false;
  try {
    trustProxy = parseTrustProxy(env.TRUST_PROXY);
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (problems.length) {
    throw new Error(`Invalid settings (see .env.example):\n- ${problems.join('\n- ')}`);
  }
  return {
    port,
    host: env.HOST || '127.0.0.1', // Docker needs HOST=0.0.0.0; empty would mean all interfaces
    trustProxy,
    adminPassword,
    sessionSecret,
    dataDir: resolve(root, env.DATA_DIR || 'data'),
    contentDir: resolve(root, env.CONTENT_DIR || 'content'),
    demo: env.DEMO_MODE === 'true',
    ...(eventPassword ? { eventPassword } : {}),
    eventDir: resolve(root, env.EVENT_DIR || 'event'),
    event: env.EVENT_MODE === 'true',
  };
}
