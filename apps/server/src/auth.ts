// Admin login and guest sessions: signed cookies with node:crypto, no extra dependency.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LOGIN_FAILS_PER_IP_MAX, LOGIN_WINDOW_MS, RATE_LIMIT_MAX_KEYS } from './game/config';

export const ADMIN_COOKIE = 'ido_admin';
export const GUEST_COOKIE = 'ido_guest';
/** Admin login lasts this long. */
export const ADMIN_MAX_AGE_SEC = 7 * 24 * 3600;
/** Guest sessions last this long: the evening plus slack for the rehearsal. */
export const GUEST_MAX_AGE_SEC = 7 * 24 * 3600;

/** A new random id (session ids, file names): 128+ bits, safe in URLs and cookies. */
export function newId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

function mac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Equal-time string compare (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function sign(value: string, secret: string): string {
  return `${value}.${mac(value, secret)}`;
}

/** The signed value, or undefined if the signature is wrong. */
export function unsign(signed: string, secret: string): string | undefined {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const value = signed.slice(0, dot);
  return safeEqual(signed.slice(dot + 1), mac(value, secret)) ? value : undefined;
}

/** Admin cookies are signed with the admin password mixed in: changing the password logs all admins out. */
const adminKey = (secret: string, password: string) => `${secret}\0admin\0${password}`;

/** Admin cookie value: "a.<expiry ms>", signed. The "a." prefix keeps it apart from guest cookies. */
export function adminToken(now: number, secret: string, password: string): string {
  return sign(`a.${now + ADMIN_MAX_AGE_SEC * 1000}`, adminKey(secret, password));
}

export function isAdminToken(
  token: string | undefined,
  now: number,
  secret: string,
  password: string,
): boolean {
  const value = token && unsign(token, adminKey(secret, password));
  const m = value ? /^a\.(\d{1,15})$/.exec(value) : null;
  return !!m && Number(m[1]) > now;
}

/**
 * Guest cookie value: "g.<session id>.<expiry ms>", signed. Self-contained: opening the join
 * link stores nothing on the server, so nobody can fill the server up by opening it.
 */
export function guestToken(sid: string, now: number, secret: string): string {
  return sign(`g.${sid}.${now + GUEST_MAX_AGE_SEC * 1000}`, secret);
}

/**
 * The session id from a guest cookie, or undefined if it's forged or expired. Cookies from
 * before Phase 6.7 also carry a join tag (random join links); it is read over and ignored.
 */
export function guestSid(
  token: string | undefined,
  now: number,
  secret: string,
): string | undefined {
  const value = token && unsign(token, secret);
  const m = value
    ? /^g\.([A-Za-z0-9_-]{16,64})(?:\.[A-Za-z0-9_-]{12})?\.(\d{1,15})$/.exec(value)
    : null;
  return m && Number(m[2]) > now ? m[1] : undefined;
}

/** Parses a Cookie header. Only our own cookie names are read, so a small parser is enough. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSec: number, secure: boolean): string {
  return [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * The limiter's bucket for an IP: IPv4 as is, IPv6 by its /64 network (one device or home
 * usually gets a whole /64, so counting single IPv6 addresses would allow endless guessing).
 */
export function ipBucket(ip: string): string {
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(':')) return ip;
  const addr = ip.split('%')[0]!.toLowerCase(); // drop a zone id like %eth0
  const [head = '', tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups =
    tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':')}::/64`;
}

/**
 * At most `max` events per key within the window (key = e.g. an IP bucket or a session id).
 * Memory-bounded: the least recently active keys are forgotten first.
 */
export class RateLimiter {
  private byKey = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** How many keys are remembered (for tests). */
  get size(): number {
    return this.byKey.size;
  }

  blocked(key: string, now: number): boolean {
    this.prune(now);
    const recent = (this.byKey.get(key) ?? []).filter((t) => now - t < this.windowMs);
    return recent.length >= this.max;
  }

  record(key: string, now: number): void {
    this.prune(now);
    const times = [...(this.byKey.get(key) ?? []), now].filter((t) => now - t < this.windowMs);
    this.byKey.delete(key); // re-insert: the Map keeps the most recently active keys last
    this.byKey.set(key, times.slice(-this.max));
    for (const oldest of this.byKey.keys()) {
      if (this.byKey.size <= RATE_LIMIT_MAX_KEYS) break;
      this.byKey.delete(oldest);
    }
  }

  /** Records the event if allowed. Returns false (and records nothing) when over the limit. */
  take(key: string, now: number): boolean {
    if (this.blocked(key, now)) return false;
    this.record(key, now);
    return true;
  }

  /** Forgets keys whose last event is outside the window. The Map is ordered by last event. */
  private prune(now: number): void {
    for (const [key, times] of this.byKey) {
      if (now - (times.at(-1) ?? 0) < this.windowMs) break;
      this.byKey.delete(key);
    }
  }
}

/**
 * Brute-force brake for the admin login: at most N failed attempts per IP within the window.
 * A correct password is still refused from a blocked IP. There is deliberately no global limit:
 * it would let anyone lock the admin out. Guessing a 12+ character password 10 tries per IP per
 * 15 minutes is hopeless anyway.
 */
export class LoginLimiter {
  private readonly limiter = new RateLimiter(LOGIN_FAILS_PER_IP_MAX, LOGIN_WINDOW_MS);

  get size(): number {
    return this.limiter.size;
  }

  blocked(ip: string, now: number): boolean {
    return this.limiter.blocked(ipBucket(ip), now);
  }

  fail(ip: string, now: number): void {
    this.limiter.record(ipBucket(ip), now);
  }
}
