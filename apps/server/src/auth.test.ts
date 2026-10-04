import { describe, expect, it } from 'vitest';
import {
  ADMIN_MAX_AGE_SEC,
  GUEST_MAX_AGE_SEC,
  adminToken,
  cookie,
  guestSid,
  guestToken,
  ipBucket,
  isAdminToken,
  LoginLimiter,
  newId,
  RateLimiter,
  parseCookies,
  safeEqual,
  sign,
  unsign,
} from './auth';
import { LOGIN_FAILS_PER_IP_MAX, LOGIN_WINDOW_MS, RATE_LIMIT_MAX_KEYS } from './game/config';
import { clientIp } from './http';
import { identify, restoreSessions, SessionStore } from './sessions';

const SECRET = 'x'.repeat(32);
const OTHER = 'y'.repeat(32);
const PW = 'admin-password';
const secrets = { sessionSecret: SECRET, adminPassword: PW };

describe('signing', () => {
  it('round-trips and rejects tampering or another secret', () => {
    const s = sign('g.abc', SECRET);
    expect(unsign(s, SECRET)).toBe('g.abc');
    expect(unsign(s, OTHER)).toBeUndefined();
    expect(unsign(s.replace('abc', 'abd'), SECRET)).toBeUndefined();
    expect(unsign('nodot', SECRET)).toBeUndefined();
    expect(unsign('', SECRET)).toBeUndefined();
  });

  it('compares strings of any length safely', () => {
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'same!')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('admin and guest tokens', () => {
  it('admin token works until it expires', () => {
    const t = adminToken(1_000, SECRET, PW);
    expect(isAdminToken(t, 1_000, SECRET, PW)).toBe(true);
    expect(isAdminToken(t, 1_000 + ADMIN_MAX_AGE_SEC * 1000, SECRET, PW)).toBe(false);
    expect(isAdminToken(t, 1_000, OTHER, PW)).toBe(false);
    expect(isAdminToken(undefined, 1_000, SECRET, PW)).toBe(false);
  });

  it('changing the admin password logs all admins out', () => {
    const t = adminToken(0, SECRET, PW);
    expect(isAdminToken(t, 1, SECRET, 'new-password!')).toBe(false);
  });

  it('guest token works until it expires', () => {
    const sid = newId();
    const g = guestToken(sid, 1_000, SECRET);
    expect(guestSid(g, 1_000, SECRET)).toBe(sid);
    expect(guestSid(g, 1_000 + GUEST_MAX_AGE_SEC * 1000, SECRET)).toBeUndefined();
    expect(guestSid(g, 1_000, OTHER)).toBeUndefined();
  });

  it('guest and admin tokens cannot stand in for each other', () => {
    const g = guestToken(newId(), 0, SECRET);
    expect(isAdminToken(g, 0, SECRET, PW)).toBe(false);
    expect(guestSid(adminToken(0, SECRET, PW), 0, SECRET)).toBeUndefined();
    // even if both were signed with the same key
    expect(guestSid(sign('a.99999999999', SECRET), 0, SECRET)).toBeUndefined();
  });
});

describe('cookies', () => {
  it('parses a Cookie header, first value wins', () => {
    const c = parseCookies('a=1; ido_guest=g.x.y ; a=2; junk');
    expect(c.get('a')).toBe('1');
    expect(c.get('ido_guest')).toBe('g.x.y');
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('a=1'.padEnd(9000, 'x')).size).toBe(0);
  });

  it('sets HttpOnly and SameSite, and Secure only on https', () => {
    expect(cookie('n', 'v', 60, false)).toBe('n=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
    expect(cookie('n', 'v', 60, true)).toMatch(/; Secure$/);
  });
});

describe('LoginLimiter', () => {
  it('blocks an IP after too many failures, until the window passes', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < LOGIN_FAILS_PER_IP_MAX; i++) l.fail('1.1.1.1', i);
    expect(l.blocked('1.1.1.1', 100)).toBe(true);
    expect(l.blocked('2.2.2.2', 100)).toBe(false);
    expect(l.blocked('1.1.1.1', LOGIN_WINDOW_MS + 100)).toBe(false);
  });

  it('failures from many IPs never lock out the admin', () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 1000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`, 0);
    expect(l.blocked('2.2.2.2', 1)).toBe(false);
  });

  it('counts IPv6 addresses by their /64 network', () => {
    expect(ipBucket('1.2.3.4')).toBe('1.2.3.4');
    expect(ipBucket('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipBucket('2001:db8:0:1::1d')).toBe('2001:db8:0:1::/64');
    expect(ipBucket('2001:0DB8:0000:0001:ffff:1:2:3')).toBe('2001:db8:0:1::/64');
    expect(ipBucket('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    const l = new LoginLimiter();
    for (let i = 0; i < LOGIN_FAILS_PER_IP_MAX; i++) l.fail(`2001:db8::${i.toString(16)}`, 0);
    expect(l.blocked('2001:db8::ffff', 1)).toBe(true);
    expect(l.blocked('2001:db8:1::1', 1)).toBe(false);
  });

  it('remembers a bounded number of IPs', () => {
    const l = new LoginLimiter();
    for (let n = 0; n < LOGIN_FAILS_PER_IP_MAX; n++) l.fail('9.9.9.9', 0);
    for (let i = 0; i <= RATE_LIMIT_MAX_KEYS; i++) l.fail(`ip${i}`, 1);
    // the least recently failing IP was forgotten to keep memory bounded
    expect(l.blocked('9.9.9.9', 2)).toBe(false);
    expect(l.size).toBe(RATE_LIMIT_MAX_KEYS);
  });
});

describe('sessions', () => {
  const guest = (sid: string) => `ido_guest=${guestToken(sid, 0, SECRET)}`;

  it('identifies signed cookies; a guest needs no server-side record', () => {
    const sid = newId();
    const header = `${guest(sid)}; ido_admin=${adminToken(0, SECRET, PW)}`;
    expect(identify(header, secrets, 1)).toEqual({ admin: true, sid });
    expect(identify(header, { sessionSecret: OTHER, adminPassword: PW }, 1)).toEqual({
      admin: false,
    });
    expect(identify('ido_guest=g.forged.1.abc', secrets, 1)).toEqual({ admin: false });
  });

  it('cookies from before the fixed join link (with a join tag) keep their device', () => {
    const sid = newId();
    const old = sign(`g.${sid}.abcdefghijkl.${GUEST_MAX_AGE_SEC * 1000}`, SECRET);
    expect(identify(`ido_guest=${old}`, secrets, 1)).toEqual({ admin: false, sid });
    // a tag of the wrong length is not a cookie of ours
    const odd = sign(`g.${sid}.abc.${GUEST_MAX_AGE_SEC * 1000}`, SECRET);
    expect(identify(`ido_guest=${odd}`, secrets, 1)).toEqual({ admin: false });
  });

  it('binds a session to a guest id, refusing unsafe ids', () => {
    const store = new SessionStore();
    const sid = newId();
    expect(store.guestOf(sid)).toBeNull();
    expect(store.bind(sid, '__proto__', 0)).toBe(false);
    expect(store.bind('short', 'g001', 0)).toBe(false);
    expect(store.bind(sid, 'g001', 5)).toBe(true);
    expect(store.guestOf(sid)).toBe('g001');
    expect(store.sessions[sid]).toEqual({ boundAt: 5, guestId: 'g001' });
    expect(store.guestOf('constructor')).toBeNull();
  });

  it('restores valid sessions and rejects bad ones', () => {
    const sid = newId();
    expect(restoreSessions({ [sid]: { boundAt: 1, guestId: 'g001' } })).toEqual({
      [sid]: { boundAt: 1, guestId: 'g001' },
    });
    expect(() => restoreSessions({ short: { boundAt: 1, guestId: 'g001' } })).toThrow();
    expect(() => restoreSessions({ [sid]: { boundAt: 'x', guestId: 'g001' } })).toThrow();
    expect(() => restoreSessions({ [sid]: { boundAt: 1, guestId: null } })).toThrow();
    expect(() => restoreSessions({ [sid]: { boundAt: 1, guestId: '__proto__' } })).toThrow();
  });
});

describe('RateLimiter', () => {
  it('allows max events per key within the window, then again after it', () => {
    const l = new RateLimiter(3, 1_000);
    expect([l.take('a', 0), l.take('a', 1), l.take('a', 2), l.take('a', 3)]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(l.take('b', 3)).toBe(true); // other keys are separate
    expect(l.take('a', 1_001)).toBe(true); // the first event left the window
  });
});

describe('clientIp', () => {
  const req = (remoteAddress: string, xff?: string) => ({
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress },
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientIp(req('10.0.0.1', '6.6.6.6'), false)).toBe('10.0.0.1');
    expect(clientIp(req('10.0.0.1', '6.6.6.6, 1.2.3.4'), true)).toBe('1.2.3.4'); // added by the proxy
    expect(clientIp(req('10.0.0.1'), true)).toBe('10.0.0.1');
  });

  it('with a list of proxy IPs, trusts the header only from those', () => {
    expect(clientIp(req('::ffff:10.0.0.2', '1.2.3.4'), '10.0.0.1, 10.0.0.2')).toBe('1.2.3.4');
    expect(clientIp(req('10.9.9.9', '6.6.6.6'), '10.0.0.1')).toBe('10.9.9.9');
  });
});
