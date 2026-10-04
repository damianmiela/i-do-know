// Integration tests: a real server on a free port, real HTTP requests and Socket.IO clients.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Ack,
  ClientToServerEvents,
  GameRecord,
  GameSummary,
  GuestView,
  HostView,
  Localized,
  ServerToClientEvents,
  View,
} from '@idoknow/shared';
import { PODIUM_STEPS, TOO_MANY_CONNECTIONS } from '@idoknow/shared';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './env';
import type { Guest } from './game/collect';
import {
  CLAIM_PER_IP_PER_MINUTE,
  SEARCH_PER_IP_PER_MINUTE,
  SEARCH_RATE_MAX,
  SOCKETS_PER_SESSION_MAX,
} from './game/config';
import type { Question } from './game/quiz';
import { createServer, QUESTIONS_SAVE_FAILED, type AppServer, type ServerOptions } from './server';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const PASSWORD = 'correct horse battery';
const t = (en: string): Localized => ({ pl: en, es: en, ca: en, de: en, en });
const questions: Question[] = ['q1', 'q2'].map((id) => ({
  id,
  kind: 'choice',
  text: t(id),
  options: [t('a'), t('b'), t('c')],
  correct: 1,
}));

const guests: Guest[] = [
  { id: 'g001', name: 'Ann Łódzka', country: 'PL', side: 'bride' },
  { id: 'g002', name: 'Bob Núñez', country: 'ES', side: 'groom' },
  { id: 'g003', name: 'Cid Weiß', country: 'DE', side: 'groom' },
];
const EVENT = {
  title: t('Who knows Zofia & Xavi best?'),
  sides: { bride: 'Zofia', groom: 'Xavi' },
};

let dir: string;
const servers: AppServer[] = [];
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idoknow-server-'));
  // own content folder, so the tests never read real questions
  writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions }));
  writeFileSync(join(dir, 'guests.json'), JSON.stringify({ guests }));
  writeFileSync(join(dir, 'event.json'), JSON.stringify(EVENT));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  for (const s of servers.splice(0)) await s.app.close();
  // Windows: a file write that is still finishing can block the delete for a moment
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface StartOptions {
  port?: number;
  trustProxy?: boolean;
  /** Serve a fake built client from this folder. */
  clientDist?: string;
  logger?: ServerOptions['logger'];
  /** Joining open (default here, so tests can claim names; a real server starts closed). */
  joining?: boolean;
  /** Auto-reveal (off here, so steps stay where tests put them; a real server starts with it on). */
  autoReveal?: boolean;
  now?: () => number;
  /** Collect mode (off on a real server: shelved in Phase 9). */
  collect?: boolean;
  /** Reading time before the answers (off here, so tests answer at once; a real server: on). */
  reading?: boolean;
  /** The public demo (DEMO_MODE). */
  demo?: boolean;
  /** The demo's switch to the event, or a server already playing the event. */
  eventPassword?: string;
  eventDir?: string;
  event?: boolean;
  restart?: () => void;
}

async function start({
  port = 0,
  trustProxy = false,
  clientDist,
  logger = false,
  joining,
  autoReveal = false,
  now,
  collect = false,
  reading = false,
  demo = false,
  eventPassword,
  eventDir,
  event,
  restart,
}: StartOptions = {}) {
  const config: Config = {
    port,
    host: '127.0.0.1',
    trustProxy,
    adminPassword: PASSWORD,
    sessionSecret: 'test-secret-'.repeat(4),
    dataDir: join(dir, 'data'),
    contentDir: dir,
    demo,
    ...(eventPassword ? { eventPassword } : {}),
    ...(eventDir ? { eventDir } : {}),
    ...(event ? { event } : {}),
  };
  const srv = await createServer(config, {
    botAnswerMs: [20, 80], // demo players answer at once here
    ...(restart ? { restart } : {}),
    logger,
    ...(clientDist ? { clientDist } : {}),
    ...(now ? { now } : {}),
    collectMode: collect,
  });
  servers.push(srv);
  // (the demo keeps its own default: open)
  if (joining !== undefined || !demo) srv.ctx.joiningOpen = joining ?? true;
  srv.ctx.autoReveal = autoReveal;
  srv.ctx.readingStep = reading;
  await srv.app.listen({ port, host: '127.0.0.1' });
  const actual = (srv.app.server.address() as AddressInfo).port;
  return { srv, port: actual, url: `http://127.0.0.1:${actual}` };
}

/** GET with the path sent exactly as given (fetch and URL would clean up "..", even encoded). */
function rawGet(url: string, path: string, cookie = ''): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    request({ hostname, port, path, headers: { cookie } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

const cookieOf = (res: Response) => res.headers.getSetCookie()[0]?.split(';')[0] ?? '';
/** The session id inside a guest cookie ("ido_guest=g.<sid>.<expiry>.<signature>"). */
const sidOf = (cookie: string) => cookie.split('.')[1] ?? '';

function login(url: string, password = PASSWORD, headers: Record<string, string> = {}) {
  return fetch(`${url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ password }).toString(),
  });
}

/** Opens the join link (the QR code), with the device's cookies. */
function join_(url: string, cookie = '') {
  return fetch(`${url}/join`, { redirect: 'manual', headers: { cookie } });
}

function connect(url: string, view: View, cookie: string, reconnect = false): Client {
  const c: Client = connectClient(url, {
    auth: { view },
    extraHeaders: { cookie },
    transports: ['websocket'],
    forceNew: true,
    reconnection: reconnect,
    reconnectionDelay: 50,
    reconnectionDelayMax: 200,
  });
  if (view === 'host') c.on('state:host', (v) => hostViews.set(c, v));
  clients.push(c);
  return c;
}

/** Resolves with the next event of that name that passes `check`. */
function next<E extends keyof ServerToClientEvents>(
  c: Client,
  event: E,
  check: (v: Parameters<ServerToClientEvents[E]>[0]) => boolean = () => true,
) {
  return new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve) => {
    const on = (v: Parameters<ServerToClientEvents[E]>[0]) => {
      if (!check(v)) return;
      c.off(event, on as never);
      resolve(v);
    };
    c.on(event, on as never);
  });
}

/** The latest host view each host client got (for the step it sends back). */
const hostViews = new WeakMap<Client, HostView>();

/** A host step action (start, next, …), sent with the step the host is looking at. */
function step(host: Client, event: StepEvent) {
  const view = hostViews.get(host);
  const at =
    (event === 'host:pause' || event === 'host:resume' ? view?.pauseStep : view?.step) ?? '';
  return host.timeout(2000).emitWithAck(event, { at });
}
type StepEvent =
  | 'host:pause'
  | 'host:resume'
  | 'host:start'
  | 'host:next'
  | 'host:skip'
  | 'host:restart'
  | 'host:startWarmup'
  | 'host:endWarmup'
  | 'host:podiumNext'
  | 'host:showRanking'
  | 'host:showAnswers'
  | 'host:coupleNext';

function refused(c: Client) {
  return new Promise<string>((resolve) => c.on('connect_error', (e) => resolve(e.message)));
}

/** Logs in, joins one guest (claims g001 through guest:claim), and connects both. */
async function game(url: string) {
  const admin = cookieOf(await login(url));
  const host = connect(url, 'host', admin);
  await next(host, 'state:host');
  const guestCookie = cookieOf(await join_(url));
  const guest = connect(url, 'play', guestCookie, true);
  await next(guest, 'state:guest');
  const joined = next(guest, 'state:guest', (v) => v.joined);
  expect(await guest.timeout(2000).emitWithAck('guest:claim', { guestId: 'g001' })).toEqual({
    ok: true,
  });
  await joined;
  return { admin, host, guest, guestCookie };
}

describe('the site is closed without a login or join link', () => {
  it('sends pages to the login and refuses everything else', async () => {
    const { url } = await start();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    for (const page of ['/host', '/screen']) {
      const res = await fetch(url + page, { redirect: 'manual' });
      expect(res.status).toBe(302);
      // the big screen comes back to itself after the login
      expect(res.headers.get('location')).toBe(
        page === '/screen' ? '/login?next=/screen' : '/login',
      );
    }
    // the guest page and the bare domain lead to the join link, not the admin login
    for (const page of ['/', '/play']) {
      const res = await fetch(url + page, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/join');
    }
    expect((await fetch(`${url}/assets/app.js`)).status).toBe(401);
    const loginPage = await fetch(`${url}/login`);
    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain('href="/join"'); // for guests who ended up here
    expect(loginPage.headers.get('x-frame-options')).toBe('DENY');
  });

  it('admin login: wrong password refused, right one lets in', async () => {
    const { url } = await start();
    expect((await login(url, 'wrong')).status).toBe(401);
    const ok = await login(url);
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/host');
    expect(ok.headers.getSetCookie()[0]).toMatch(/^ido_admin=.+HttpOnly; SameSite=Lax$/);
    const res = await fetch(`${url}/host`, {
      redirect: 'manual',
      headers: { cookie: cookieOf(ok) },
    });
    expect(res.status).not.toBe(302); // past the gate (404 here: no built client in tests)
  });

  it('refuses a login posted from another site', async () => {
    const { url } = await start();
    expect((await login(url, PASSWORD, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('blocks an IP after too many wrong passwords', async () => {
    const { url } = await start();
    for (let i = 0; i < 10; i++) await login(url, 'wrong');
    expect((await login(url)).status).toBe(429);
  });

  it('the join link gives a guest session limited to /play; again keeps the same session', async () => {
    const { url } = await start({ joining: false }); // also while joining is closed
    const res = await join_(url);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/play?j');
    const guest = cookieOf(res);
    expect(sidOf(guest)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(sidOf(cookieOf(await join_(url, guest)))).toBe(sidOf(guest));
    const host = await fetch(`${url}/host`, { redirect: 'manual', headers: { cookie: guest } });
    expect(host.headers.get('location')).toBe('/play');
    const play = await fetch(`${url}/play`, { redirect: 'manual', headers: { cookie: guest } });
    expect(play.status).not.toBe(302);
    expect((await fetch(`${url}/play?j`, { headers: { cookie: guest } })).status).not.toBe(400);
  });

  it('a browser that refuses cookies gets an explanation, not a redirect loop', async () => {
    const { url } = await start();
    // /join → /play?j arrives without the cookie: say so (a loop would end in "too many redirects")
    const res = await fetch(`${url}/play?j`, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/does not keep cookies/);
    expect((await fetch(`${url}/play`, { redirect: 'manual' })).headers.get('location')).toBe(
      '/join',
    );
  });

  it('image bodies are read only by the photo upload, never on other routes', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/login`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      // above the normal 16 KB limit: only the photo route's own parser (1.5 MB) would take it
      // (before audit 8 the login read it and answered 401); small, so the test never stalls
      body: Buffer.alloc(20_000),
    });
    expect(res.status).toBe(415);
  });
});

describe('Socket.IO access', () => {
  it('refuses sockets without a valid cookie for their view', async () => {
    const { url } = await start();
    const guest = cookieOf(await join_(url));
    const admin = cookieOf(await login(url));
    expect(await refused(connect(url, 'play', ''))).toBe('unauthorized');
    expect(await refused(connect(url, 'host', guest))).toBe('unauthorized');
    expect(await refused(connect(url, 'play', admin))).toBe('unauthorized');
    expect(await refused(connect(url, 'host', admin.replace(/.$/, '_')))).toBe('unauthorized');
    expect(await refused(connect(url, 'nope' as View, admin))).toBe('unauthorized');
  });

  it('refuses sockets opened from another site', async () => {
    const { url } = await start();
    const admin = cookieOf(await login(url));
    const c: Client = connectClient(url, {
      auth: { view: 'host' },
      extraHeaders: { cookie: admin, origin: 'https://evil.example' },
      transports: ['polling'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(c);
    await refused(c);
    expect(c.connected).toBe(false);
  });
});

describe('playing', () => {
  it('runs a question: no secrets before the reveal, points after', async () => {
    const { url } = await start();
    const { host, guest } = await game(url);

    const question = next(guest, 'state:guest', (v) => v.phase === 'question');
    expect(await step(host, 'host:start')).toEqual({ ok: true });
    const q = await question;
    expect(JSON.stringify(q)).not.toMatch(/"correct"|correctOption/);
    expect(q.question?.options).toHaveLength(3);

    expect(await step(guest, 'host:next')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(
      await guest
        .timeout(2000)
        .emitWithAck('quiz:answer', { option: 'x' as never, questionId: 'q1' }),
    ).toEqual({
      ok: false,
      error: 'invalid-input',
    });
    const locked = next(guest, 'state:guest', (v) => v.myAnswer === 1);
    expect(
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' }),
    ).toEqual({
      ok: true,
    });
    await locked;
    expect(
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 2, questionId: 'q1' }),
    ).toEqual({
      ok: false,
      error: 'already-answered',
    });

    const counted = next(host, 'state:host', (v) => v.answeredCount === 1);
    await counted;
    const revealed = next(guest, 'state:guest', (v) => v.phase === 'reveal');
    await step(host, 'host:next');
    const r = await revealed;
    expect(r).toMatchObject({ correctOption: 1, myAnswer: 1, rank: 1 });
    expect(r.myPoints).toBeGreaterThan(900);
  });

  it('checks host input', async () => {
    const { url } = await start();
    const { host } = await game(url);
    await step(host, 'host:start');
    expect(await host.timeout(2000).emitWithAck('host:addTime', { ms: -5 })).toEqual({
      ok: false,
      error: 'invalid-time',
    });
    expect(await host.timeout(2000).emitWithAck('host:addTime', null as never)).toEqual({
      ok: false,
      error: 'invalid-input',
    });
    expect(await host.timeout(2000).emitWithAck('host:addTime', { ms: 10_000 })).toEqual({
      ok: true,
    });
  });

  it('a device without a name cannot answer', async () => {
    const { url } = await start();
    const admin = cookieOf(await login(url));
    const host = connect(url, 'host', admin);
    await next(host, 'state:host');
    await step(host, 'host:start');
    const guest = connect(url, 'play', cookieOf(await join_(url)));
    const v = await next(guest, 'state:guest');
    expect(v).toMatchObject({ joined: false, phase: 'question' });
    expect(
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 0, questionId: 'q1' }),
    ).toEqual({
      ok: false,
      error: 'not-joined',
    });
  });

  it('joining closed: new devices wait, joined guests stay in; opening lets them in live', async () => {
    const { url, srv } = await start({ joining: false });
    const admin = cookieOf(await login(url));
    const host = connect(url, 'host', admin);
    expect((await next(host, 'state:host')).joiningOpen).toBe(false);
    const phone = connect(url, 'play', cookieOf(await join_(url)));
    expect(await next(phone, 'state:guest')).toMatchObject({ joined: false, joiningOpen: false });
    for (const [event, payload] of [
      ['guest:search', { query: 'ann' }],
      ['guest:claim', { guestId: 'g001' }],
    ] as const) {
      expect(await phone.timeout(2000).emitWithAck(event, payload as never)).toEqual({
        ok: false,
        error: 'joining-closed',
      });
    }
    expect(srv.ctx.sessions.sessions).toEqual({});

    // the waiting phone learns at once that joining is open (no new scan needed)
    const opened = next(phone, 'state:guest', (v) => v.joiningOpen);
    expect(await host.timeout(2000).emitWithAck('host:setJoining', { open: true })).toEqual({
      ok: true,
    });
    await opened;
    expect(await phone.timeout(2000).emitWithAck('guest:claim', { guestId: 'g001' })).toEqual({
      ok: true,
    });

    // closed again: the guest with a name plays on, but can't give the name back (no way back)
    await host.timeout(2000).emitWithAck('host:setJoining', { open: false });
    expect(await phone.timeout(2000).emitWithAck('guest:unclaim')).toEqual({
      ok: false,
      error: 'joining-closed',
    });
    expect(srv.ctx.sessions.isTaken('g001')).toBe(true);
    for (const bad of [null, { open: 'yes' }, {}]) {
      expect(await host.timeout(2000).emitWithAck('host:setJoining', bad as never)).toEqual({
        ok: false,
        error: 'invalid-input',
      });
    }
    expect(await phone.timeout(2000).emitWithAck('host:setJoining', { open: true })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('the joining switch is saved and survives a restart', async () => {
    const first = await start({ joining: false });
    const host = connect(first.url, 'host', cookieOf(await login(first.url)));
    await next(host, 'state:host');
    await host.timeout(2000).emitWithAck('host:setJoining', { open: true });
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);
    const config: Config = { ...first.srv.ctx.config };
    const again = await createServer(config, { logger: false });
    servers.push(again);
    expect(again.ctx.joiningOpen).toBe(true);
  });
});

describe('restart', () => {
  it('phones reconnect by themselves after a restart and keep their score', async () => {
    const first = await start();
    const { host, guest } = await game(first.url);
    await step(host, 'host:start');
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(host, 'host:next'); // reveal: points awarded
    const score = first.srv.ctx.quiz.state.players.g001!.score;
    expect(score).toBeGreaterThan(0);

    const reasons: string[] = [];
    guest.on('disconnect', (reason) => reasons.push(reason));
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);

    // same port, same data folder: like `docker restart`
    const back = next(guest, 'state:guest', (v: GuestView) => v.joined);
    await start({ port: first.port });
    const v = await back;
    expect(v).toMatchObject({ phase: 'reveal', score, name: 'Ann Łódzka', myAnswer: 1 });
    // "io server disconnect" would mean the phone never reconnects on its own
    expect(reasons).toEqual(['transport close']);
  });
});

describe('audit 2 fixes', () => {
  it('opening the join link many times stores nothing, so real guests can always join', async () => {
    const { url, srv } = await start();
    for (let i = 0; i < 300; i++) expect((await join_(url)).status).toBe(303);
    expect(srv.ctx.sessions.sessions).toEqual({});
    const guest = cookieOf(await join_(url));
    const c = connect(url, 'play', guest);
    expect((await next(c, 'state:guest')).joined).toBe(false);
  });

  it('with a built client: who can reach what', async () => {
    const dist = join(dir, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
    mkdirSync(join(dist, 'brand'));
    writeFileSync(join(dist, 'brand', 'logo.webp'), 'logo');
    const { url } = await start({ clientDist: dist });
    const admin = cookieOf(await login(url));
    const guest = cookieOf(await join_(url));
    const get = (path: string, cookie = '') =>
      fetch(url + path, { redirect: 'manual', headers: { cookie } });

    // anonymous: nothing but the login and the join link, also not via odd /join/ paths
    for (const path of ['/join/a/b', `/join/${'x'.repeat(120)}`, '/', '/play', '/index.html']) {
      const res = await get(path);
      expect([302, 401]).toContain(res.status);
      expect(await res.text()).not.toContain('<title>app</title>');
    }
    expect((await get('/assets/app.js')).status).toBe(401);
    // logos and fonts are public; nothing else
    expect((await get('/brand/logo.webp')).status).toBe(200);
    for (const path of ['/brand/../index.html', '/brand/%2e%2e/index.html']) {
      expect(await rawGet(url, path)).not.toBe(200);
    }
    // guest: /play and static files only
    expect(await (await get('/play', guest)).text()).toContain('<title>app</title>');
    expect((await get('/assets/app.js', guest)).status).toBe(200);
    expect((await get('/host', guest)).headers.get('location')).toBe('/play');
    // admin: everything
    for (const path of ['/host', '/screen']) {
      expect(await (await get(path, admin)).text()).toContain('<title>app</title>');
    }
    expect((await get('/assets/missing.js', admin)).status).toBe(404);
  });

  it('logout clears the admin cookie, and only from this site', async () => {
    const { url } = await start();
    const logout = (headers: Record<string, string>) =>
      fetch(`${url}/logout`, { method: 'POST', redirect: 'manual', headers });
    expect((await logout({ origin: 'https://evil.example' })).status).toBe(403);
    const res = await logout({});
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()[0]).toMatch(/^ido_admin=; .*Max-Age=0/);
  });

  it('cookies are Secure behind an HTTPS proxy, and only when the proxy is trusted', async () => {
    const proxied = await start({ trustProxy: true });
    const https = await login(proxied.url, PASSWORD, { 'x-forwarded-proto': 'https' });
    expect(https.headers.getSetCookie()[0]).toMatch(/; Secure$/);
    const plain = await start();
    const faked = await login(plain.url, PASSWORD, { 'x-forwarded-proto': 'https' });
    expect(faked.headers.getSetCookie()[0]).not.toMatch(/Secure/);
  });

  it('a new admin password logs out existing admin cookies', async () => {
    const first = await start();
    const admin = cookieOf(await login(first.url));
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);
    const config: Config = { ...first.srv.ctx.config, adminPassword: 'a different password' };
    const srv = await createServer(config, { logger: false });
    servers.push(srv);
    await srv.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(srv.app.server.address() as AddressInfo).port}`;
    expect(await refused(connect(url, 'host', admin))).toBe('unauthorized');
  });
});

describe('Phase 3: guest list and join flow', () => {
  /** A device that opened the join link and is connected, but hasn't picked a name. */
  async function device(url: string) {
    const cookie = cookieOf(await join_(url));
    const c = connect(url, 'play', cookie);
    await next(c, 'state:guest');
    return { c, cookie };
  }

  it('search: accent-insensitive, at least 2 letters, shows taken names', async () => {
    const { url } = await start();
    const { guest } = await game(url); // g001 "Ann Łódzka" is taken
    // a device with a name never reads the list again (audit 8)
    expect(await guest.timeout(2000).emitWithAck('guest:search', { query: 'ann' })).toEqual({
      ok: false,
      error: 'already-joined',
    });
    const { c } = await device(url);
    expect(await c.timeout(2000).emitWithAck('guest:search', { query: 'a' })).toEqual({
      ok: false,
      error: 'query-too-short',
    });
    expect(await c.timeout(2000).emitWithAck('guest:search', { query: 'lodz' })).toEqual({
      ok: true,
      results: [{ id: 'g001', name: 'Ann Łódzka', country: 'PL', taken: true }],
    });
    const r = (await c.timeout(2000).emitWithAck('guest:search', { query: 'nunez' })) as Ack;
    expect(r).toMatchObject({ ok: true, results: [{ id: 'g002', taken: false }] });
    expect(await c.timeout(2000).emitWithAck('guest:search', { query: 42 as never })).toEqual({
      ok: false,
      error: 'invalid-input',
    });
  });

  it('search is rate-limited per phone', async () => {
    const { url } = await start();
    const { c } = await device(url);
    const replies = (await Promise.all(
      Array.from({ length: 31 }, () =>
        c.timeout(2000).emitWithAck('guest:search', { query: 'bob' }),
      ),
    )) as Ack[];
    expect(replies.filter((r) => r.ok)).toHaveLength(30);
    expect(replies.at(-1)).toEqual({ ok: false, error: 'rate-limited' });
  });

  it('a name is locked to one device; the host can release it; the score stays with the name', async () => {
    const { url, srv } = await start();
    const { host, guest } = await game(url);
    await step(host, 'host:start');
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(host, 'host:next'); // reveal: points for g001
    const score = srv.ctx.quiz.state.players.g001!.score;

    const other = await device(url);
    expect(await other.c.timeout(2000).emitWithAck('guest:claim', { guestId: 'g001' })).toEqual({
      ok: false,
      error: 'name-taken',
    });
    expect(await guest.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' })).toEqual({
      ok: false,
      error: 'already-joined',
    });
    expect(await other.c.timeout(2000).emitWithAck('guest:claim', { guestId: 'nobody' })).toEqual({
      ok: false,
      error: 'unknown-guest',
    });
    expect(Object.keys(srv.ctx.sessions.sessions)).toHaveLength(1);

    // the host releases g001: the first phone goes back to the name search
    const back = next(guest, 'state:guest', (v) => !v.joined);
    const list = next(host, 'state:guests', (rows) => !rows.find((r) => r.id === 'g001')?.claimed);
    expect(await host.timeout(2000).emitWithAck('host:releaseGuest', { guestId: 'g001' })).toEqual({
      ok: true,
    });
    await back;
    await list;
    // now the other phone can take the name, and gets the score
    const joined = next(other.c, 'state:guest', (v) => v.joined);
    expect(await other.c.timeout(2000).emitWithAck('guest:claim', { guestId: 'g001' })).toEqual({
      ok: true,
    });
    expect((await joined).score).toBe(score);
  });

  it('the host list shows claim and online status; guests never get it', async () => {
    const { url } = await start();
    const { host, guest } = await game(url);
    let guestGotList = false;
    guest.on('state:guests', () => (guestGotList = true));
    const rows = await next(host, 'state:guests', (r) => !!r.find((g) => g.id === 'g001')?.online);
    expect(rows.find((g) => g.id === 'g001')).toMatchObject({ claimed: true, added: false });
    expect(rows.find((g) => g.id === 'g002')).toMatchObject({ claimed: false, online: false });
    expect(await guest.timeout(2000).emitWithAck('host:releaseGuest', { guestId: 'g001' })).toEqual(
      { ok: false, error: 'forbidden' },
    );
    expect(guestGotList).toBe(false);
  });

  it('the host adds a missing guest, who can then join, also after a restart', async () => {
    const first = await start();
    const admin = cookieOf(await login(first.url));
    const host = connect(first.url, 'host', admin);
    await next(host, 'state:host');
    const payload = { name: 'Pau Serra', country: 'ES', side: 'groom' as const };
    expect(await host.timeout(2000).emitWithAck('host:addGuest', payload)).toEqual({
      ok: true,
      guestId: 'added-1',
    });
    expect(await host.timeout(2000).emitWithAck('host:addGuest', payload)).toEqual({
      ok: false,
      error: 'duplicate-name',
    });
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);

    const { url } = await start();
    const { c } = await device(url);
    expect(await c.timeout(2000).emitWithAck('guest:search', { query: 'pau' })).toMatchObject({
      results: [{ id: 'added-1', name: 'Pau Serra' }],
    });
    expect(await c.timeout(2000).emitWithAck('guest:claim', { guestId: 'added-1' })).toEqual({
      ok: true,
    });
  });

  it("collect mode is shelved: phones can't claim a wristband", async () => {
    const { url } = await start();
    const { guest } = await game(url);
    expect(await guest.timeout(2000).emitWithAck('collect:claimBand', { code: 'K7P2' })).toEqual({
      ok: false,
      error: 'collect-off',
    });
  });

  it('wristband: "this is me", taken bands, and unlinking by the host', async () => {
    const { url } = await start({ collect: true });
    const { host, guest } = await game(url);
    const other = await device(url);
    expect(await other.c.timeout(2000).emitWithAck('collect:claimBand', { code: 'K7P2' })).toEqual({
      ok: false,
      error: 'not-joined',
    });
    const linked = next(guest, 'state:guest', (v) => v.band === 'K7P2');
    expect(await guest.timeout(2000).emitWithAck('collect:claimBand', { code: ' k7p2 ' })).toEqual({
      ok: true,
    });
    await linked;
    await other.c.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' });
    expect(await other.c.timeout(2000).emitWithAck('collect:claimBand', { code: 'K7P2' })).toEqual({
      ok: false,
      error: 'band-taken',
    });
    expect(await guest.timeout(2000).emitWithAck('collect:claimBand', { code: 'ZZ99' })).toEqual({
      ok: false,
      error: 'already-has-band',
    });
    const unlinked = next(guest, 'state:guest', (v) => v.joined && v.band === undefined);
    expect(await host.timeout(2000).emitWithAck('host:unlinkBand', { code: 'k7p2' })).toEqual({
      ok: true,
    });
    await unlinked;
    expect(await host.timeout(2000).emitWithAck('host:unlinkBand', { code: 'K7P2' })).toEqual({
      ok: false,
      error: 'unknown-band',
    });
  });

  it('opening /play refreshes the guest cookie, keeping the same session', async () => {
    const { url } = await start();
    const cookie = cookieOf(await join_(url));
    const res = await fetch(`${url}/play`, { redirect: 'manual', headers: { cookie } });
    expect(sidOf(cookieOf(res))).toBe(sidOf(cookie));
    expect(res.headers.getSetCookie()[0]).toMatch(/Max-Age=604800/);
  });
});

describe('audit 3 fixes', () => {
  async function device(url: string) {
    const cookie = cookieOf(await join_(url));
    const c = connect(url, 'play', cookie);
    await next(c, 'state:guest');
    return { c, cookie };
  }

  it('search limits count per phone across reconnects, and per IP across phones', async () => {
    const { url } = await start();
    const first = await device(url);
    for (let i = 0; i < 30; i++) {
      await first.c.timeout(2000).emitWithAck('guest:search', { query: 'bob' });
    }
    const again = connect(url, 'play', first.cookie); // reconnect: same phone
    await next(again, 'state:guest');
    expect(await again.timeout(2000).emitWithAck('guest:search', { query: 'bob' })).toEqual({
      ok: false,
      error: 'rate-limited',
    });
    // more phones from the same IP use up the (generous) per-IP budget
    const phones = SEARCH_PER_IP_PER_MINUTE / SEARCH_RATE_MAX - 1;
    for (let p = 0; p < phones; p++) {
      const d = await device(url);
      await Promise.all(
        Array.from({ length: SEARCH_RATE_MAX }, () =>
          d.c.timeout(5000).emitWithAck('guest:search', { query: 'bob' }),
        ),
      );
      d.c.disconnect();
    }
    const admin = cookieOf(await login(url));
    const host = connect(url, 'host', admin);
    await next(host, 'state:host');
    const warned = next(host, 'state:host', (v) => v.warnings.some((w) => /name searches/.test(w)));
    const fresh = await device(url);
    expect(await fresh.c.timeout(2000).emitWithAck('guest:search', { query: 'bob' })).toEqual({
      ok: false,
      error: 'rate-limited',
    });
    await warned; // the host is told, so they can make a new join link
  });

  it('claims are limited per IP, so a script cannot take every name at once', async () => {
    const many: Guest[] = Array.from({ length: CLAIM_PER_IP_PER_MINUTE + 2 }, (_, i) => ({
      id: `m${i}`,
      name: `Maria Number${i}`,
      country: 'ES',
      side: 'bride',
    }));
    writeFileSync(join(dir, 'guests.json'), JSON.stringify({ guests: many }));
    const { url } = await start();
    const replies: Ack[] = [];
    for (let i = 0; i <= CLAIM_PER_IP_PER_MINUTE; i++) {
      const d = await device(url);
      replies.push(
        (await d.c.timeout(2000).emitWithAck('guest:claim', { guestId: `m${i}` })) as Ack,
      );
      d.c.disconnect();
    }
    expect(replies.filter((r) => r.ok)).toHaveLength(CLAIM_PER_IP_PER_MINUTE);
    expect(replies.at(-1)).toEqual({ ok: false, error: 'rate-limited' });
  });

  it('claiming your own wristband again saves and sends nothing', async () => {
    const { url, srv } = await start({ collect: true });
    const { guest } = await game(url);
    await guest.timeout(2000).emitWithAck('collect:claimBand', { code: 'K7P2' });
    const save = vi.spyOn(srv.ctx.snapshots, 'saveNow');
    for (let i = 0; i < 20; i++) {
      expect(await guest.timeout(2000).emitWithAck('collect:claimBand', { code: 'K7P2' })).toEqual({
        ok: true,
      });
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('a claim reaches the other phones as one throttled update', async () => {
    const { url } = await start();
    const watcher = await device(url);
    let updates = 0;
    watcher.c.on('state:guest', () => updates++);
    for (const id of ['g001', 'g002', 'g003']) {
      const d = await device(url);
      await d.c.timeout(2000).emitWithAck('guest:claim', { guestId: id });
    }
    const counted = await next(watcher.c, 'state:guest', (v) => v.playerCount === 3);
    expect(counted.playerCount).toBe(3);
    expect(updates).toBeLessThan(3);
  });
});

describe('Phase 4: photos', () => {
  it('serves quiz photos only to guests and admins, and only plain image names', async () => {
    mkdirSync(join(dir, 'photos'));
    writeFileSync(join(dir, 'photos', 'baby-1.webp'), 'fake-webp');
    writeFileSync(join(dir, 'photos', 'notes.txt'), 'secret');
    writeFileSync(join(dir, 'photos', '.hidden.webp'), 'secret');
    const { url } = await start();
    const { guestCookie: guest } = await game(url); // a guest with a name
    const unnamed = cookieOf(await join_(url));
    const admin = cookieOf(await login(url));
    const get = (path: string, cookie = '') => fetch(url + path, { headers: { cookie } });

    expect((await get('/photos/baby-1.webp')).status).toBe(401); // no session: nothing
    // anyone can open the join link: the private photos need a picked name (audit 8)
    expect((await get('/photos/baby-1.webp', unnamed)).status).toBe(401);
    const ok = await get('/photos/baby-1.webp', guest);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('fake-webp');
    expect(ok.headers.get('cache-control')).toBe('private, max-age=43200');
    expect((await get('/photos/baby-1.webp', admin)).status).toBe(200);
    for (const path of ['/photos/notes.txt', '/photos/.hidden.webp']) {
      expect((await get(path, guest)).status).toBeGreaterThanOrEqual(400);
    }
    writeFileSync(join(dir, 'secret.webp'), 'secret'); // next to the photos folder
    for (const path of ['/photos/../secret.webp', '/photos/%2e%2e/secret.webp']) {
      expect(await rawGet(url, path, guest)).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('audit 4 and simplicity changes', () => {
  async function device(url: string) {
    const cookie = cookieOf(await join_(url));
    const c = connect(url, 'play', cookie);
    await next(c, 'state:guest');
    return { c, cookie };
  }

  it('a late answer meant for an earlier question never counts', async () => {
    const { url, srv } = await start();
    const { host, guest } = await game(url);
    await step(host, 'host:start');
    await step(host, 'host:skip'); // now at q2
    expect(
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' }),
    ).toEqual({ ok: false, error: 'wrong-question' });
    expect(srv.ctx.quiz.state.answers).toEqual({});
  });

  it('a guest can give their name back before the quiz starts, not after', async () => {
    const { url, srv } = await start();
    const { host, guest } = await game(url);
    const back = next(guest, 'state:guest', (v) => !v.joined);
    expect(await guest.timeout(2000).emitWithAck('guest:unclaim')).toEqual({ ok: true });
    await back;
    expect(srv.ctx.sessions.isTaken('g001')).toBe(false);
    expect(srv.ctx.quiz.state.players.g001).toBeUndefined(); // off the player list again
    // pick the right name, then the quiz starts: no more changing
    await guest.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' });
    await step(host, 'host:start');
    expect(await guest.timeout(2000).emitWithAck('guest:unclaim')).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
  });

  it('warm-up rounds: practice questions for everyone, played again and again, no real points', async () => {
    const warmup = questions.map((q) => ({ ...q, id: `w-${q.id}` }));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, warmup }));
    const { url, srv } = await start();
    const { host, guest } = await game(url);
    const hostState = await next(host, 'state:host', (v) => v.warmupAvailable);
    expect(hostState.phase).toBe('lobby');

    for (let round = 0; round < 2; round++) {
      const practice = next(guest, 'state:guest', (v) => v.phase === 'question' && !!v.warmup);
      expect(await step(host, 'host:startWarmup')).toEqual({ ok: true });
      const q = await practice;
      expect(q.question?.id).toBe('w-q1');
      expect(
        await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'w-q1' }),
      ).toEqual({ ok: true });
      await step(host, 'host:next'); // reveal
      expect(srv.ctx.warmup.quiz?.state.players.g001?.score).toBeGreaterThan(0);
      const lobby = next(guest, 'state:guest', (v) => v.phase === 'lobby' && !v.warmup);
      expect(await step(host, 'host:endWarmup')).toEqual({ ok: true });
      await lobby;
      expect(srv.ctx.quiz.state.players.g001?.score).toBe(0); // the real quiz is untouched
    }
    // only from the lobby of the real quiz
    await step(host, 'host:start');
    expect(await step(host, 'host:startWarmup')).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
  });

  it('without warm-up questions the host gets no-warmup', async () => {
    const { url } = await start();
    const { host } = await game(url);
    expect(await step(host, 'host:startWarmup')).toEqual({
      ok: false,
      error: 'no-warmup',
    });
  });

  it('phones hear how many have answered while the question runs', async () => {
    const { url } = await start();
    const { host, guest } = await game(url);
    const other = await device(url);
    await other.c.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' });
    await step(host, 'host:start');
    const heard = next(other.c, 'state:answered', (n) => n.answeredCount === 1);
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    expect(await heard).toEqual({ answeredCount: 1, playerCount: 2 });
  });

  it('cache headers: built files for good, logos and fonts for a day, the page never', async () => {
    // folders named like ours ABOVE dist (e.g. a server path /srv/assets/…) must not count
    const dist = join(dir, 'assets', 'fonts', 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(join(dist, 'brand'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dist, 'assets', 'app-1a2b.js'), 'x');
    writeFileSync(join(dist, 'brand', 'logo.webp'), 'x');
    const { url } = await start({ clientDist: dist });
    const admin = cookieOf(await login(url));
    const cache = async (path: string, cookie = admin) =>
      (await fetch(url + path, { headers: { cookie } })).headers.get('cache-control');
    expect(await cache('/assets/app-1a2b.js')).toBe('public, max-age=31536000, immutable');
    expect(await cache('/brand/logo.webp', '')).toBe('public, max-age=86400');
    expect(await cache('/host')).toBe('no-cache');
    // only real logo/font files are public: no way to the app page through /brand/
    for (const path of ['/brand/host', '/brand/.hidden', '/fonts/x']) {
      const res = await fetch(url + path, { redirect: 'manual' });
      expect(await res.text()).not.toContain('<title>app</title>');
    }
  });
});

describe('Phase 5: big screen', () => {
  it('the host sets the screen language; the screen gets it and the joining switch', async () => {
    const { url } = await start();
    const { admin, host } = await game(url);
    const screen = connect(url, 'screen', admin);
    expect(await next(screen, 'state:screen')).toMatchObject({ lang: 'en', joiningOpen: true });
    const polish = next(screen, 'state:screen', (v) => v.lang === 'pl');
    expect(await host.timeout(2000).emitWithAck('host:setScreenLang', { lang: 'pl' })).toEqual({
      ok: true,
    });
    await polish;
    for (const lang of ['xx', '__proto__', 5, null]) {
      expect(await host.timeout(2000).emitWithAck('host:setScreenLang', { lang } as never)).toEqual(
        { ok: false, error: 'invalid-input' },
      );
    }
    // closing joining reaches the screen at once ("Joining opens soon" instead of the QR code)
    const closed = next(screen, 'state:screen', (v) => !v.joiningOpen);
    await host.timeout(2000).emitWithAck('host:setJoining', { open: false });
    await closed;
  });

  it('the podium is revealed by the host; phones learn their place only after it', async () => {
    const { url, srv } = await start();
    const { host, guest } = await game(url);
    expect(await step(host, 'host:podiumNext')).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
    await step(host, 'host:start');
    await step(host, 'host:skip'); // q2, the last question
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q2' });
    const lastReveal = next(guest, 'state:guest', (v) => v.phase === 'reveal');
    await step(host, 'host:next');
    const atlastReveal = await lastReveal;
    expect(atlastReveal.rankHidden).toBe(true);
    expect(atlastReveal.rank).toBeUndefined();
    const final = next(guest, 'state:guest', (v) => v.phase === 'final');
    await step(host, 'host:next');
    const atfinal = await final;
    expect(atfinal.rankHidden).toBe(true);
    expect(atfinal.rank).toBeUndefined();

    // one player: the empty 3rd and 2nd places are skipped
    const placed = next(guest, 'state:guest', (v) => v.rank === 1);
    expect(await step(host, 'host:podiumNext')).toEqual({ ok: true });
    await placed;
    expect(srv.ctx.screen.podiumShown).toBe(3);
    expect(await step(host, 'host:podiumNext')).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
    // a restart starts the next podium from the beginning
    await step(host, 'host:restart');
    expect(srv.ctx.screen.podiumShown).toBe(0);
  });
});

describe('re-audit 4 fixes', () => {
  const withWarmup = () => {
    const warmup = questions.map((q) => ({ ...q, id: `w-${q.id}` }));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, warmup }));
  };

  it('a guest who picks a name during the warm-up plays it at once; giving it back leaves it', async () => {
    withWarmup();
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:startWarmup');
    const cookie = cookieOf(await join_(url));
    const late = connect(url, 'play', cookie);
    await next(late, 'state:guest');
    const playing = next(late, 'state:guest', (v) => v.joined && !!v.warmup);
    await late.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' });
    expect(await playing).toMatchObject({ phase: 'question', joined: true });
    expect(srv.ctx.warmup.quiz?.state.players.g002).toBeDefined();
    expect(await late.timeout(2000).emitWithAck('guest:unclaim')).toEqual({ ok: true });
    expect(srv.ctx.warmup.quiz?.state.players.g002).toBeUndefined();
    expect(srv.ctx.quiz.state.players.g002).toBeUndefined();
  });

  it('Restart during the warm-up ends it: Start then starts the real quiz', async () => {
    withWarmup();
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:startWarmup');
    expect(await step(host, 'host:restart')).toEqual({ ok: true });
    expect(srv.ctx.warmup.quiz).toBeNull();
    await step(host, 'host:start');
    expect(srv.ctx.quiz.state.phase).toBe('question');
  });

  it('refuses warm-up ids that are also question ids, and an empty questions.json', async () => {
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, warmup: questions }));
    await expect(start()).rejects.toThrow(/warmup id "q1" is also a question id/);
    writeFileSync(join(dir, 'questions.json'), 'null');
    await expect(start()).rejects.toThrow(/has problems/);
  });
});

describe('audit 5 fixes', () => {
  it('the login leads back to the big screen, never to another site', async () => {
    const { url } = await start();
    const form = (next: string) =>
      fetch(`${url}/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: PASSWORD, next }).toString(),
      });
    expect((await form('/screen')).headers.get('location')).toBe('/screen');
    for (const next of ['//evil.example', 'https://evil.example', '/play', '']) {
      expect((await form(next)).headers.get('location')).toBe('/host');
    }
    const page = await (await fetch(`${url}/login?next=/screen`)).text();
    expect(page).toContain('name="next" value="/screen"');
    const odd = await (await fetch(`${url}/login?next=%22%3E%3Cscript%3E`)).text();
    expect(odd).toContain('name="next" value="/host"');
  });
});

describe('Phase 6: host panel', () => {
  it('only the host gets the questions with their answers, plus counts and the last save', async () => {
    const { url, srv } = await start();
    const admin = cookieOf(await login(url));
    const host = connect(url, 'host', admin);
    const first = next(host, 'state:host');
    const lists = await next(host, 'state:questions');
    expect(lists.questions.map((q) => [q.id, q.correct])).toEqual(
      srv.ctx.quiz.questions.map((q) => [q.id, q.correct]),
    );
    const state = await first;
    expect(state).toMatchObject({ joinedGuests: 0, guestCount: 3, saveFailing: false });
    await srv.ctx.snapshots.flush(); // the startup save
    const guestCookie = cookieOf(await join_(url));
    const guest = connect(url, 'play', guestCookie);
    const screen = connect(url, 'screen', admin);
    let leaked = false;
    const leak = () => {
      leaked = true;
    };
    guest.on('state:questions' as never, leak);
    screen.on('state:questions' as never, leak);
    await next(guest, 'state:guest');
    await next(screen, 'state:screen');
    const joined = next(host, 'state:host', (v) => v.joinedGuests === 1);
    await guest.timeout(2000).emitWithAck('guest:claim', { guestId: 'g001' });
    const after = await joined;
    expect(after.savedAgoMs).toBeGreaterThanOrEqual(0);
    expect(leaked).toBe(false);
  });

  it('the Top 10 comes after every question, not after the last one', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:start');
    await step(host, 'host:next'); // reveal q1
    await step(host, 'host:next');
    expect(srv.ctx.quiz.state.phase).toBe('leaderboard');
    await step(host, 'host:next'); // q2
    await step(host, 'host:next'); // reveal q2
    await step(host, 'host:next');
    expect(srv.ctx.quiz.state.phase).toBe('final');
  });

  it('releases the names picked in the last N minutes, not older ones', async () => {
    let now = 1_000_000;
    const { url, srv } = await start();
    srv.ctx.now = () => now;
    const { host, guest } = await game(url); // g001, picked "now"
    now += 10 * 60_000;
    const late = connect(url, 'play', cookieOf(await join_(url)));
    await next(late, 'state:guest');
    await late.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' });
    now += 60_000;
    for (const minutes of [0, 1.5, 241, '5', undefined]) {
      expect(
        await host.timeout(2000).emitWithAck('host:releaseRecent', { minutes } as never),
      ).toEqual({ ok: false, error: 'invalid-input' });
    }
    const back = next(late, 'state:guest', (v) => !v.joined);
    expect(await host.timeout(2000).emitWithAck('host:releaseRecent', { minutes: 5 })).toEqual({
      ok: true,
      released: 1,
    });
    await back;
    expect(srv.ctx.sessions.isTaken('g002')).toBe(false);
    expect(srv.ctx.sessions.isTaken('g001')).toBe(true); // picked 11 minutes ago
    void guest;
  });
});

describe('audit 6 fixes', () => {
  it('a double tap or a second host can never skip a step', async () => {
    const { url, srv } = await start();
    const { admin, host } = await game(url);
    const helper = connect(url, 'host', admin);
    await next(helper, 'state:host');
    await step(host, 'host:start');
    const at = hostViews.get(host)!.step;
    expect(await host.timeout(2000).emitWithAck('host:next', { at })).toEqual({ ok: true });
    // the same tap again (double tap, or replayed after a reconnect): refused
    expect(await host.timeout(2000).emitWithAck('host:next', { at })).toEqual({
      ok: false,
      error: 'stale',
    });
    // a helper who still sees the question taps "reveal" too: refused
    expect(await helper.timeout(2000).emitWithAck('host:next', { at })).toEqual({
      ok: false,
      error: 'stale',
    });
    expect(srv.ctx.quiz.state.phase).toBe('reveal'); // not the Top 10, not question 2
    for (const payload of [undefined, {}, { at: 5 }]) {
      expect(await host.timeout(2000).emitWithAck('host:next', payload as never)).toEqual({
        ok: false,
        error: 'invalid-input',
      });
    }
  });

  it('the host hears about a failed save at once', async () => {
    const { url, srv } = await start();
    const admin = cookieOf(await login(url));
    const host = connect(url, 'host', admin);
    await next(host, 'state:host');
    await srv.ctx.snapshots.flush();
    await new Promise((r) => setTimeout(r, 600)); // no other update pending: only the save's
    // the data folder becomes a file: every save fails from now on
    rmSync(join(dir, 'data'), { recursive: true, force: true });
    writeFileSync(join(dir, 'data'), 'not a folder');
    const warned = next(host, 'state:host', (v) => v.saveFailing);
    await host.timeout(2000).emitWithAck('host:setScreenLang', { lang: 'pl' });
    await warned;
    rmSync(join(dir, 'data'), { force: true });
    const fine = next(host, 'state:host', (v) => !v.saveFailing && (v.savedAgoMs ?? 1e9) < 1000);
    await host.timeout(2000).emitWithAck('host:setScreenLang', { lang: 'es' });
    await fine;
  }, 15_000); // Windows: deleting and re-creating the folder can take a few seconds

  it('"connected" counts only guests with a name; released names leave the player list', async () => {
    const { url, srv } = await start();
    const { host, guest } = await game(url); // g001 joined and connected
    const browsing = connect(url, 'play', cookieOf(await join_(url)));
    await next(browsing, 'state:guest'); // a device still looking for its name
    const counted = next(host, 'state:host', (v) => v.joinedGuests === 1);
    await host.timeout(2000).emitWithAck('host:setScreenLang', { lang: 'de' });
    expect((await counted).connectedGuests).toBe(1);
    expect(srv.ctx.quiz.state.players.g001).toBeDefined();
    const back = next(guest, 'state:guest', (v) => !v.joined);
    await host.timeout(2000).emitWithAck('host:releaseGuest', { guestId: 'g001' });
    await back;
    expect(srv.ctx.quiz.state.players.g001).toBeUndefined(); // lobby: off the list too
  });

  it('after the start a released name keeps its points', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:start');
    await host.timeout(2000).emitWithAck('host:releaseGuest', { guestId: 'g001' });
    expect(srv.ctx.quiz.state.players.g001).toBeDefined();
  });
});

describe('Phase 6.6: question editor', () => {
  const draft = (en: string) => ({
    kind: 'choice' as const,
    text: t(en),
    options: [t('yes'), t('no')],
    correct: 0,
  });
  const saved = () =>
    JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as {
      questions: { id: string; text: Localized }[];
      warmup: unknown[];
    };

  async function editor() {
    const { url, srv } = await start();
    const { host, admin } = await game(url);
    return { url, srv, host, admin };
  }

  it('adds, edits, moves and deletes questions, and writes questions.json each time', async () => {
    const { srv, host } = await editor();
    const lists = next(host, 'state:questions', (l) => l.questions.length === 3);
    const added = (await host.timeout(2000).emitWithAck('host:questionSave', {
      list: 'questions',
      question: draft('New one'),
      index: 0,
    })) as Ack<{ id: string }>;
    expect(added).toMatchObject({ ok: true });
    const id = (added as { id: string }).id;
    expect(id).toMatch(/^q-[A-Za-z0-9]{2,}$/); // neutral, never a hint at the answer
    expect((await lists).questions[0]?.id).toBe(id);
    expect(srv.ctx.quiz.questions.map((q) => q.id)).toEqual([id, 'q1', 'q2']);
    await srv.ctx.questionWriter.save(
      { questions: [...srv.ctx.quiz.questions], warmup: [], sets: [] },
      srv.ctx.timeLimitSec,
    );
    expect(saved().questions.map((q) => q.id)).toEqual([id, 'q1', 'q2']);

    // edit: same id, new text; anything else the client sends is dropped
    const changed = { ...draft('Changed'), id, sneaky: 'x' };
    expect(
      await host
        .timeout(2000)
        .emitWithAck('host:questionSave', { list: 'questions', question: changed }),
    ).toEqual({ ok: true, id });
    expect(srv.ctx.quiz.questions[0]).not.toHaveProperty('sneaky');
    expect(srv.ctx.quiz.questions[0]?.text.en).toBe('Changed');

    await host.timeout(2000).emitWithAck('host:questionMove', { list: 'questions', id, to: 5 });
    expect(srv.ctx.quiz.questions.map((q) => q.id)).toEqual(['q1', 'q2', id]);
    await host.timeout(2000).emitWithAck('host:questionDelete', { list: 'questions', id: 'q1' });
    await srv.ctx.questionWriter.save(
      { questions: [...srv.ctx.quiz.questions], warmup: [], sets: [] },
      srv.ctx.timeLimitSec,
    );
    expect(saved().questions.map((q) => q.id)).toEqual(['q2', id]);
    expect(existsSync(join(dir, 'questions.prev.json'))).toBe(true); // the version before
    expect(srv.ctx.quiz.state.players.g001).toBeDefined(); // players stay in the waiting room
  });

  it('refuses bad edits, and every edit outside the waiting room', async () => {
    const { host } = await editor();
    const save = (payload: unknown) =>
      host.timeout(2000).emitWithAck('host:questionSave', payload as never);
    expect(await save({ list: 'nope', question: draft('x') })).toEqual({
      ok: false,
      error: 'unknown-set',
    });
    expect(await save({ list: 5, question: draft('x') })).toEqual({
      ok: false,
      error: 'invalid-input',
    });
    expect(await save({ list: 'questions', question: { ...draft('x'), correct: 7 } })).toEqual({
      ok: false,
      error: 'invalid-question',
    });
    expect(await save({ list: 'questions', question: { ...draft('x'), id: 'zzz' } })).toEqual({
      ok: false,
      error: 'unknown-question',
    });
    const photo = { ...draft('x'), kind: 'photo', photo: 'photo-missing.webp' };
    expect(await save({ list: 'questions', question: photo })).toEqual({
      ok: false,
      error: 'unknown-photo',
    });
    await step(host, 'host:start');
    expect(await save({ list: 'questions', question: draft('x') })).toEqual({
      ok: false,
      error: 'editing-locked',
    });
  });

  it('a draft may miss translations, but then the quiz cannot start', async () => {
    const { host } = await editor();
    const half = { ...draft('Only English'), text: { ...t(''), en: 'Only English' } };
    const added = (await host
      .timeout(2000)
      .emitWithAck('host:questionSave', { list: 'questions', question: half })) as Ack<{
      id: string;
    }>;
    expect(added.ok).toBe(true);
    const warned = await next(host, 'state:host', (v) =>
      v.warnings.some((w) => /miss(es)? translations/.test(w)),
    );
    expect(warned.phase).toBe('lobby');
    expect(await step(host, 'host:start')).toEqual({ ok: false, error: 'translations-missing' });
    const full = { ...draft('Now complete'), id: (added as { id: string }).id };
    await host
      .timeout(2000)
      .emitWithAck('host:questionSave', { list: 'questions', question: full });
    expect(await step(host, 'host:start')).toEqual({ ok: true });
  });

  it('the first save turns the example questions into content/questions.json', async () => {
    rmSync(join(dir, 'questions.json'));
    writeFileSync(join(dir, 'questions.example.json'), JSON.stringify({ questions }));
    const { srv, host } = await editor();
    expect(srv.ctx.notes.some((w) => w.includes('EXAMPLE questions'))).toBe(true);
    await host
      .timeout(2000)
      .emitWithAck('host:questionSave', { list: 'questions', question: draft('Mine') });
    await srv.ctx.questionWriter.save(
      { questions: [...srv.ctx.quiz.questions], warmup: [], sets: [] },
      srv.ctx.timeLimitSec,
    );
    expect(saved().questions).toHaveLength(3);
    expect(srv.ctx.notes.some((w) => w.includes('EXAMPLE questions'))).toBe(false);
  });

  it('one timer for every question: set in the waiting room, saved in questions.json', async () => {
    // a file from before Phase 6.7: a per-question time is ignored (and dropped when saved)
    const old = questions.map((q) => ({ ...q, timeLimitSec: 15 }));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions: old }));
    const { srv, host } = await editor();
    expect(hostViews.get(host)?.timeLimitSec).toBe(60);
    expect(srv.ctx.quiz.limitMs()).toBe(60_000);
    for (const sec of [9, 301, 45.5, '60', null]) {
      expect(await host.timeout(2000).emitWithAck('host:setTimer', { sec } as never)).toEqual({
        ok: false,
        error: 'invalid-input',
      });
    }
    const updated = next(host, 'state:host', (v) => v.timeLimitSec === 45);
    const lists = next(host, 'state:questions', (l) => l.questions[0]?.timeLimitSec === 45);
    expect(await host.timeout(2000).emitWithAck('host:setTimer', { sec: 45 })).toEqual({
      ok: true,
    });
    await Promise.all([updated, lists]);
    expect(srv.ctx.quiz.state.players.g001).toBeDefined(); // the waiting room stays as it was
    await srv.ctx.questionWriter.save(
      { questions: [...srv.ctx.quiz.questions], warmup: [], sets: [] },
      srv.ctx.timeLimitSec,
    );
    const file = JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as {
      timeLimitSec: number;
      questions: object[];
    };
    expect(file.timeLimitSec).toBe(45);
    expect(file.questions[0]).not.toHaveProperty('timeLimitSec');

    // the phones' countdown is the new one
    await step(host, 'host:start');
    expect(srv.ctx.quiz.limitMs()).toBe(45_000);
    expect(await host.timeout(2000).emitWithAck('host:setTimer', { sec: 30 })).toEqual({
      ok: false,
      error: 'editing-locked',
    });
  });

  it('a restart keeps the timer; a bad timer in questions.json stops the start', async () => {
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ timeLimitSec: 90, questions }));
    const { srv } = await start();
    expect(srv.ctx.timeLimitSec).toBe(90);
    expect(srv.ctx.quiz.timeLimitSec).toBe(90);
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ timeLimitSec: 5, questions }));
    await expect(start()).rejects.toThrow(/timeLimitSec must be a whole number from 10 to 300/);
  });

  describe('photo upload', () => {
    // a tiny but real WebP header ("RIFF....WEBPVP8 ")
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x20, 0, 0, 0]),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(32),
    ]);
    const upload = (url: string, body: Buffer, type: string, cookie: string, origin?: string) =>
      fetch(`${url}/host/photos`, {
        method: 'POST',
        headers: {
          'content-type': type,
          cookie,
          ...(origin ? { origin } : {}),
        },
        body,
      });

    it('only the host, only from this site, only real images; the server picks the name', async () => {
      const { url } = await start();
      const admin = cookieOf(await login(url));
      expect((await upload(url, webp, 'image/webp', '')).status).toBe(401);
      expect((await upload(url, webp, 'image/webp', admin, 'https://evil.example')).status).toBe(
        403,
      );
      expect((await upload(url, Buffer.alloc(64), 'image/webp', admin)).status).toBe(415);
      expect((await upload(url, webp, 'image/png', admin)).status).toBe(415); // type ≠ bytes
      expect((await upload(url, Buffer.alloc(1_600_000), 'image/webp', admin)).status).toBe(413);
      const ok = await upload(url, webp, 'image/webp', admin);
      expect(ok.status).toBe(200);
      const { name } = (await ok.json()) as { name: string };
      expect(name).toMatch(/^photo-[A-Za-z0-9]{4,10}\.webp$/);
      expect(readFileSync(join(dir, 'photos', name))).toEqual(webp);
      // and a photo question can now use it
      const { host } = await game(url);
      const photoQ = { ...draft('Who is it?'), kind: 'photo', photo: name };
      expect(
        await host
          .timeout(2000)
          .emitWithAck('host:questionSave', { list: 'questions', question: photoQ as never }),
      ).toMatchObject({ ok: true });
    });
  });
});

describe('re-audit 6/7 fixes', () => {
  it('two hosts revealing the same podium place: only one tap counts', async () => {
    const { url, srv } = await start();
    const { admin, host, guest } = await game(url);
    const other = connect(url, 'play', cookieOf(await join_(url)));
    await next(other, 'state:guest');
    await other.timeout(2000).emitWithAck('guest:claim', { guestId: 'g002' });
    const third = connect(url, 'play', cookieOf(await join_(url)));
    await next(third, 'state:guest');
    await third.timeout(2000).emitWithAck('guest:claim', { guestId: 'g003' });
    await step(host, 'host:start');
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await other.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await third.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(host, 'host:skip'); // q2 (the last)
    await step(host, 'host:next'); // reveal
    await step(host, 'host:next'); // final
    const helper = connect(url, 'host', admin);
    const seen = await next(helper, 'state:host', (v) => v.phase === 'final');
    const at = seen.step;
    expect(await host.timeout(2000).emitWithAck('host:podiumNext', { at })).toEqual({ ok: true });
    const afterOneTap = srv.ctx.screen.podiumShown;
    expect(await helper.timeout(2000).emitWithAck('host:podiumNext', { at })).toEqual({
      ok: false,
      error: 'stale',
    });
    expect(srv.ctx.screen.podiumShown).toBe(afterOneTap); // the second tap changed nothing
  });

  it('a double tap on Pause pauses once (it never resumes)', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:start');
    const at = hostViews.get(host)!.pauseStep;
    expect(await host.timeout(2000).emitWithAck('host:pause', { at })).toEqual({ ok: true });
    expect(await host.timeout(2000).emitWithAck('host:resume', { at })).toEqual({
      ok: false,
      error: 'stale',
    });
    expect(srv.ctx.quiz.state.pausedAt).not.toBeNull();
  });

  it('a sheet left open from an earlier warm-up round never matches a later one', async () => {
    const warmup = questions.map((q) => ({ ...q, id: `w-${q.id}` }));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, warmup }));
    const { url } = await start();
    const { host } = await game(url);
    await step(host, 'host:startWarmup');
    const old = hostViews.get(host)!.step; // e.g. "End warm-up" opened here and left open
    await step(host, 'host:endWarmup');
    await step(host, 'host:startWarmup'); // the same practice question again
    expect(hostViews.get(host)!.step).not.toBe(old);
    expect(await host.timeout(2000).emitWithAck('host:endWarmup', { at: old })).toEqual({
      ok: false,
      error: 'stale',
    });
  });

  it('releasing recent names in the lobby takes them off the player list; old names never count as recent', async () => {
    let now = 5_000_000;
    const { url, srv } = await start();
    srv.ctx.now = () => now;
    const { host } = await game(url); // g001 picked at 5 000 000
    expect(srv.ctx.quiz.state.players.g001).toBeDefined();
    now -= 3 * 3_600_000; // the clock steps back three hours
    expect(await host.timeout(2000).emitWithAck('host:releaseRecent', { minutes: 1 })).toEqual({
      ok: true,
      released: 0,
    });
    now += 3 * 3_600_000 + 30_000;
    expect(await host.timeout(2000).emitWithAck('host:releaseRecent', { minutes: 1 })).toEqual({
      ok: true,
      released: 1,
    });
    expect(srv.ctx.quiz.state.players.g001).toBeUndefined();
  });

  it('closing the server stops the "saved" updates', async () => {
    const { srv } = await start();
    expect(srv.ctx.snapshots.onWritten).toBeTypeOf('function');
    await srv.app.close();
    expect(srv.ctx.snapshots.onWritten).toBeUndefined();
  });
});

describe('audit 8 fixes', () => {
  it('a device can hold only a few sockets open (anyone can open the join link)', async () => {
    const { url } = await start();
    const cookie = cookieOf(await join_(url));
    const open: Client[] = [];
    for (let i = 0; i < SOCKETS_PER_SESSION_MAX; i++) {
      const c = connect(url, 'play', cookie);
      await next(c, 'state:guest');
      open.push(c);
    }
    expect(await refused(connect(url, 'play', cookie))).toBe(TOO_MANY_CONNECTIONS);
    // a closed one frees its place
    const gone = open.pop()!;
    gone.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    const again = connect(url, 'play', cookie);
    expect((await next(again, 'state:guest')).joined).toBe(false);
    // other devices are not affected
    const other = connect(url, 'play', cookieOf(await join_(url)));
    expect((await next(other, 'state:guest')).joined).toBe(false);
  });

  it('the questions.json warning goes away once a save works again', async () => {
    const { srv } = await start();
    const lists = { questions: [...srv.ctx.quiz.questions], warmup: [], sets: [] };
    mkdirSync(join(dir, 'questions.json.tmp')); // the write fails
    await srv.ctx.questionWriter.save(lists, 45);
    expect(srv.ctx.warnings).toContain(QUESTIONS_SAVE_FAILED);
    rmSync(join(dir, 'questions.json.tmp'), { recursive: true });
    await srv.ctx.questionWriter.save(lists, 45);
    expect(srv.ctx.warnings).not.toContain(QUESTIONS_SAVE_FAILED);
    expect(
      (JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as { timeLimitSec: number })
        .timeLimitSec,
    ).toBe(45);
  });

  it('only the five languages of a text are saved and sent', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    const junk = { ...t('Hello'), junk: 'x'.repeat(500), '<img src=x>': 1 };
    const question = {
      kind: 'choice' as const,
      text: junk,
      options: [{ ...t('a'), extra: 'y' }, t('b')],
      correct: 0,
    };
    const saved = (await host
      .timeout(2000)
      .emitWithAck('host:questionSave', { list: 'questions', question })) as Ack<{ id: string }>;
    expect(saved.ok).toBe(true);
    const q = srv.ctx.quiz.questions.at(-1)!;
    expect(Object.keys(q.text).sort()).toEqual(['ca', 'de', 'en', 'es', 'pl']);
    expect(Object.keys(q.options[0]!).sort()).toEqual(['ca', 'de', 'en', 'es', 'pl']);
  });

  it('only /preview may be framed, and only by this site', async () => {
    const { url } = await start();
    const admin = cookieOf(await login(url));
    const frame = async (path: string) =>
      (await fetch(url + path, { redirect: 'manual', headers: { cookie: admin } })).headers.get(
        'x-frame-options',
      );
    expect(await frame('/preview?as=screen')).toBe('SAMEORIGIN');
    for (const path of ['/preview/', '/host', '/screen', '/login']) {
      expect(await frame(path)).toBe('DENY');
    }
  });
});

describe('Phase 6.8: game archive', () => {
  /** Plays the whole real quiz (2 questions) with one guest to the final. */
  async function finished(url: string) {
    const g = await game(url);
    await step(g.host, 'host:start');
    await g.guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(g.host, 'host:next'); // reveal
    await step(g.host, 'host:next'); // Top 10
    await step(g.host, 'host:next'); // q2
    await step(g.host, 'host:skip'); // → final: archived
    return g;
  }

  it('saves a finished game once; the host lists, opens and deletes it', async () => {
    const { url, srv } = await start();
    const { host } = await finished(url);
    const list = (await host.timeout(2000).emitWithAck('host:games')) as Ack<{
      games: GameSummary[];
    }>;
    expect(list).toMatchObject({ ok: true, games: [{ playerCount: 1, questionCount: 2 }] });
    const id = (list as { games: GameSummary[] }).games[0]!.id;
    expect(readdirSync(join(dir, 'data', 'games'))).toEqual([`${id}.json`]);
    const opened = (await host.timeout(2000).emitWithAck('host:game', { id })) as Ack<{
      game: GameRecord;
    }>;
    const game = (opened as { game: GameRecord }).game;
    expect(game.questions[0]!.answers).toMatchObject([{ playerId: 'g001', option: 1 }]);
    expect(game.questions[1]!.skipped).toBe(true);
    expect(game.players[0]).toMatchObject({ name: 'Ann Łódzka', country: 'PL', rank: 1 });

    // the podium steps and a restart at the final don't save it again
    await step(host, 'host:podiumNext');
    expect(srv.ctx.archive.list()).toHaveLength(1);
    // a restart starts a new log
    await step(host, 'host:restart');
    expect(srv.ctx.quiz.state.log).toEqual([]);

    for (const bad of [{ id: '../snapshot' }, { id: 5 }, null]) {
      expect(await host.timeout(2000).emitWithAck('host:game', bad as never)).toEqual({
        ok: false,
        error: 'invalid-input',
      });
    }
    expect(await host.timeout(2000).emitWithAck('host:gameDelete', { id })).toEqual({ ok: true });
    expect(await host.timeout(2000).emitWithAck('host:game', { id })).toEqual({
      ok: false,
      error: 'unknown-game',
    });
  });

  it('a warm-up played to its end is never archived', async () => {
    const warmup = questions.map((x) => ({ ...x, id: `w-${x.id}` }));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, warmup }));
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:startWarmup');
    await step(host, 'host:skip');
    await step(host, 'host:skip');
    expect(srv.ctx.warmup.quiz?.state.phase).toBe('final');
    expect(srv.ctx.archive.list()).toEqual([]);
  });

  it('downloads as JSON or CSV, for the host only', async () => {
    const { url, srv } = await start();
    const { admin, guestCookie } = await finished(url);
    const id = srv.ctx.archive.list()[0]!.id;
    const get = (file: string, cookie: string) =>
      fetch(`${url}/host/games/${file}`, { headers: { cookie } });
    const json = await get(`${id}.json`, admin);
    expect(json.status).toBe(200);
    expect(json.headers.get('content-disposition')).toBe(
      `attachment; filename="idoknow-${id}.json"`,
    );
    expect(((await json.json()) as GameRecord).id).toBe(id);
    const csv = await get(`${id}.csv`, admin);
    expect(csv.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(await csv.text()).toContain('Ann Łódzka');
    // guests (even with a name) and strangers get nothing
    for (const cookie of [guestCookie, '']) {
      expect((await get(`${id}.json`, cookie)).status).toBe(401);
    }
    expect((await get('..%2Fsnapshot.json', admin)).status).toBe(404);
    expect((await get(`${id}.txt`, admin)).status).toBe(404);
  });

  it('the host shows a past game on the big screen, never during a quiz', async () => {
    const { url, srv } = await start();
    const { host, admin, guest } = await finished(url);
    const id = srv.ctx.archive.list()[0]!.id;
    const screen = connect(url, 'screen', admin);
    await next(screen, 'state:screen');
    // not over a podium still being revealed (audit 9)
    expect(await host.timeout(2000).emitWithAck('host:showPast', { id })).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
    while (srv.ctx.screen.podiumShown < PODIUM_STEPS) await step(host, 'host:podiumNext');
    const shown = next(screen, 'state:screen', (v) => v.past?.top !== undefined);
    expect(await host.timeout(2000).emitWithAck('host:showPast', { id })).toEqual({ ok: true });
    expect((await shown).past).toMatchObject({ id, top: [{ name: 'Ann Łódzka', rank: 1 }] });
    const votes = next(screen, 'state:screen', (v) => v.past?.votes !== undefined);
    await host.timeout(2000).emitWithAck('host:showPast', { id, question: 0 });
    expect((await votes).past?.votes).toMatchObject({ optionCounts: [0, 1, 0], correctOption: 1 });
    // phones never get it
    const phone = await next(guest, 'state:guest');
    expect(JSON.stringify(phone)).not.toContain('past');
    // back to the live game, and a new quiz clears it too
    await host.timeout(2000).emitWithAck('host:showPast', { id: null });
    expect(srv.ctx.screen.past).toBeUndefined();
    await host.timeout(2000).emitWithAck('host:showPast', { id });
    await step(host, 'host:restart');
    expect(srv.ctx.screen.past).toBeUndefined();
    await step(host, 'host:start');
    expect(await host.timeout(2000).emitWithAck('host:showPast', { id })).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
    expect(await host.timeout(2000).emitWithAck('host:showPast', { id, question: -1 })).toEqual({
      ok: false,
      error: 'invalid-input',
    });
  });
});

describe("ghost players (Damian's second test)", () => {
  it('a restart leaves out names released during the game', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    await step(host, 'host:start');
    // released mid-game: the score stays with the name while the game runs
    await host.timeout(2000).emitWithAck('host:releaseGuest', { guestId: 'g001' });
    expect(srv.ctx.quiz.state.players.g001).toBeDefined();
    const lobby = next(host, 'state:host', (v) => v.phase === 'lobby');
    await step(host, 'host:restart');
    expect((await lobby).playerCount).toBe(0);
    expect(srv.ctx.quiz.state.players).toEqual({});
  });
});

describe('Phase 6.9: auto-reveal, full ranking, removing added guests', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('reveals by itself once everyone has answered (a beat later), unless switched off', async () => {
    const { url, srv } = await start({ autoReveal: true });
    const { host, guest } = await game(url);
    expect(hostViews.get(host)?.autoReveal).toBe(true);
    await wait(700); // the claim's delayed broadcast is over: only the answer can arm the reveal
    await step(host, 'host:start');
    const revealed = next(guest, 'state:guest', (v) => v.phase === 'reveal');
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    expect(srv.ctx.quiz.state.phase).toBe('question'); // not at once: the ✓ first
    expect((await revealed).myPoints).toBeGreaterThan(0);
    // the Top 10 still waits for the host
    await wait(300);
    expect(srv.ctx.quiz.state.phase).toBe('reveal');

    // switched off: nothing happens by itself
    expect(await host.timeout(2000).emitWithAck('host:setAutoReveal', { on: false })).toEqual({
      ok: true,
    });
    await step(host, 'host:next'); // Top 10
    await step(host, 'host:next'); // q2
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q2' });
    await wait(2000);
    expect(srv.ctx.quiz.state.phase).toBe('question');
    expect(
      await host.timeout(2000).emitWithAck('host:setAutoReveal', { on: 'x' } as never),
    ).toEqual({ ok: false, error: 'invalid-input' });
  });

  it('reveals by itself when the time is up (plus the grace), never while paused', async () => {
    let offset = 0;
    const { url, srv } = await start({ autoReveal: true, now: () => Date.now() + offset });
    const { host } = await game(url);
    await step(host, 'host:start');
    await step(host, 'host:pause');
    offset += 70_000; // the whole minute passes while paused
    await host.timeout(2000).emitWithAck('host:setScreenLang', { lang: 'pl' }); // any change
    await wait(200);
    expect(srv.ctx.quiz.state.phase).toBe('question');
    await step(host, 'host:resume');
    offset += 70_000; // and now it runs out
    const revealed = next(host, 'state:host', (v) => v.phase === 'reveal');
    await host.timeout(2000).emitWithAck('host:setScreenLang', { lang: 'en' });
    expect((await revealed).phase).toBe('reveal');
  });

  it('the switch is saved', async () => {
    const first = await start();
    const host = connect(first.url, 'host', cookieOf(await login(first.url)));
    await next(host, 'state:host');
    await host.timeout(2000).emitWithAck('host:setAutoReveal', { on: false });
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);
    const again = await createServer({ ...first.srv.ctx.config }, { logger: false });
    servers.push(again);
    expect(again.ctx.autoReveal).toBe(false);
  });

  it('after the podium the host shows everyone their place', async () => {
    const { url } = await start();
    const { host, guest, admin: cookie } = await game(url);
    await step(host, 'host:start');
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(host, 'host:next');
    await step(host, 'host:next');
    await step(host, 'host:next');
    await step(host, 'host:skip'); // final
    expect(await step(host, 'host:showRanking')).toEqual({ ok: false, error: 'wrong-phase' });
    await step(host, 'host:podiumNext'); // one scorer: the whole podium at once
    const screen = connect(url, 'screen', cookie);
    await next(screen, 'state:screen');
    const phone = next(guest, 'state:guest', (v) => v.ranking !== undefined);
    const big = next(screen, 'state:screen', (v) => v.ranking !== undefined);
    expect(await step(host, 'host:showRanking')).toEqual({ ok: true });
    expect((await phone).ranking).toEqual([
      expect.objectContaining({ rank: 1, name: 'Ann Łódzka', me: true }),
    ]);
    expect((await big).ranking?.[0]).not.toHaveProperty('me');
    expect(await step(host, 'host:showRanking')).toMatchObject({ ok: false }); // only once
    // a restart ends it
    await step(host, 'host:restart');
    expect((await next(guest, 'state:guest')).ranking).toBeUndefined();
  });

  it('the host removes a guest they added: name, player and score go', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    const added = (await host
      .timeout(2000)
      .emitWithAck('host:addGuest', { name: 'Zoe Added', country: 'DE', side: 'groom' })) as Ack<{
      guestId: string;
    }>;
    const guestId = (added as { guestId: string }).guestId;
    const phone = connect(url, 'play', cookieOf(await join_(url)));
    await next(phone, 'state:guest');
    await phone.timeout(2000).emitWithAck('guest:claim', { guestId });
    await step(host, 'host:start');
    await phone.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(host, 'host:next');
    expect(srv.ctx.quiz.state.players[guestId]?.score).toBeGreaterThan(0);
    // an earlier round counted them too: the overall ranking forgets them (audit 9)
    srv.ctx.rounds.push({
      setId: 'questions',
      setName: 'Main quiz',
      finishedAt: 1,
      players: { [guestId]: { name: 'Zoe Added', score: 900, correctCount: 1 } },
    });

    const back = next(phone, 'state:guest', (v) => !v.joined);
    expect(await host.timeout(2000).emitWithAck('host:removeGuest', { guestId })).toEqual({
      ok: true,
    });
    await back; // that phone goes back to the name search
    expect(srv.ctx.quiz.state.players[guestId]).toBeUndefined();
    expect(srv.ctx.guests.get(guestId)).toBeUndefined();
    expect(srv.ctx.sessions.isTaken(guestId)).toBe(false);
    expect(srv.ctx.rounds[0]?.players).toEqual({});
    // guests from guests.json are edited in the file
    expect(await host.timeout(2000).emitWithAck('host:removeGuest', { guestId: 'g002' })).toEqual({
      ok: false,
      error: 'not-added',
    });
    expect(await phone.timeout(2000).emitWithAck('host:removeGuest', { guestId: 'g002' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});

describe('Phase 9.5: reading time before the answers', () => {
  it('the question comes alone; the host shows the answers and only then the clock runs', async () => {
    let now = 1_000_000;
    const { url, srv } = await start({ reading: true, now: () => now });
    const { host, guest } = await game(url);
    const screen = connect(url, 'screen', cookieOf(await login(url)));
    await next(screen, 'state:screen');
    const phoneReading = next(guest, 'state:guest', (v) => v.phase === 'question');
    const screenReading = next(screen, 'state:screen', (v) => v.phase === 'question');
    expect(await step(host, 'host:start')).toEqual({ ok: true });
    for (const v of [await phoneReading, await screenReading]) {
      expect(v.reading).toBe(true);
      expect(v.question?.text.en).toBeDefined();
      expect(v.question?.options).toEqual([]); // nobody reads (or taps) ahead
      expect(v.timeLeftMs).toBe(srv.ctx.timeLimitSec * 1000);
      expect(v.paused).toBe(false); // not a pause: "get ready"
    }
    // no answers, no pause, no reveal while reading; time doesn't run
    const id = srv.ctx.quiz.question!.id;
    expect(
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: id }),
    ).toEqual({ ok: false, error: 'wrong-phase' });
    expect(await step(host, 'host:next')).toEqual({ ok: false, error: 'wrong-phase' });
    expect(await step(host, 'host:pause')).toEqual({ ok: false, error: 'wrong-phase' });
    now += 30_000;
    expect(srv.ctx.quiz.timeLeftMs(now)).toBe(srv.ctx.timeLimitSec * 1000);
    // the answers: everywhere at once, the countdown from full
    const shown = next(guest, 'state:guest', (v) => v.phase === 'question' && !v.reading);
    expect(await step(host, 'host:showAnswers')).toEqual({ ok: true });
    expect((await shown).question?.options.length).toBeGreaterThan(1);
    expect(await step(host, 'host:showAnswers')).toMatchObject({ ok: false }); // only once
    now += 1_000;
    expect(
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: id }),
    ).toEqual({ ok: true });
    expect(srv.ctx.quiz.state.answers.g001?.elapsedMs).toBe(1_000); // from the answers, not before
    // the next question reads first again; switched off, it doesn't
    await step(host, 'host:next');
    await step(host, 'host:next');
    await step(host, 'host:next');
    expect(srv.ctx.quiz.state.reading).toBe(true);
    expect(await host.timeout(2000).emitWithAck('host:setReadingStep', { on: false })).toEqual({
      ok: true,
    });
    expect(await step(host, 'host:skip')).toEqual({ ok: true }); // skipping works while reading
    expect(srv.ctx.quiz.state.reading).toBeUndefined();
    expect(srv.ctx.quiz.state.pausedAt).toBeNull();
  });

  it('the switch and a question in its reading time survive a restart', async () => {
    const first = await start({ reading: true });
    const { host } = await game(first.url);
    await step(host, 'host:start');
    expect(first.srv.ctx.quiz.state.reading).toBe(true);
    first.srv.ctx.snapshots.saveNow();
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);
    const again = await createServer({ ...first.srv.ctx.config }, { logger: false });
    servers.push(again);
    expect(again.ctx.readingStep).toBe(true);
    expect(again.ctx.quiz.state.reading).toBe(true);
  });
});

describe('Phase 9.5: the couple plays along', () => {
  /** The bride (g002) and the groom (g003) marked in guests.json, both with a name on a phone. */
  async function coupleGame() {
    const marked = guests.map((g) =>
      g.id === 'g002' ? { ...g, role: 'bride' } : g.id === 'g003' ? { ...g, role: 'groom' } : g,
    );
    writeFileSync(join(dir, 'guests.json'), JSON.stringify({ guests: marked }));
    const { url, srv } = await start();
    const { host, guest, admin } = await game(url);
    const phones: Record<string, Client> = {};
    for (const id of ['g002', 'g003']) {
      const c = connect(url, 'play', cookieOf(await join_(url)));
      await next(c, 'state:guest');
      expect(await c.timeout(2000).emitWithAck('guest:claim', { guestId: id })).toEqual({
        ok: true,
      });
      phones[id] = c;
    }
    return { url, srv, host, guest, admin, bride: phones.g002!, groom: phones.g003! };
  }

  it('they answer off every ranking; after the full ranking the screen goes through their answers', async () => {
    const { url, srv, host, guest, admin, bride, groom } = await coupleGame();
    const marked = await next(host, 'state:host', (v) => v.coupleMarked.bride === 'Bob Núñez');
    expect(marked.coupleMarked).toEqual({ bride: 'Bob Núñez', groom: 'Cid Weiß' });
    expect(marked.coupleRound).toBe(false); // the main quiz doesn't have it on yet
    expect(
      await host.timeout(2000).emitWithAck('host:setCouple', { list: 'questions', on: true }),
    ).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(
        (JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as { couple?: boolean })
          .couple,
      ).toBe(true),
    );
    expect(
      await host.timeout(2000).emitWithAck('host:setCouple', { list: 'warmup', on: true }),
    ).toEqual({
      ok: false,
      error: 'unknown-set',
    });
    await step(host, 'host:start');
    expect(
      await host.timeout(2000).emitWithAck('host:setCouple', { list: 'questions', on: false }),
    ).toEqual({
      ok: false,
      error: 'editing-locked',
    });
    const screen = connect(url, 'screen', admin);
    await next(screen, 'state:screen');

    // q1: the guest and the bride right, the groom wrong; q2: the bride and groom alike
    const answer = (c: Client, option: number) =>
      c.timeout(2000).emitWithAck('quiz:answer', { option, questionId: srv.ctx.quiz.question!.id });
    await answer(guest, 1);
    await answer(bride, 1);
    await answer(groom, 0);
    await step(host, 'host:next'); // reveal
    const top = next(screen, 'state:screen', (v) => v.phase === 'leaderboard');
    const brideTop = next(bride, 'state:guest', (v) => v.phase === 'leaderboard');
    const guestTop = next(guest, 'state:guest', (v) => v.phase === 'leaderboard');
    await step(host, 'host:next'); // Top 10
    expect((await top).top?.map((r) => r.name)).toEqual(['Ann Łódzka']); // never the couple
    const brideView = await brideTop;
    expect(brideView).toMatchObject({ offBoard: true, rankHidden: true });
    expect(brideView).not.toHaveProperty('rank');
    expect(brideView).not.toHaveProperty('around');
    expect((await guestTop).around?.map((r) => r.name)).toEqual(['Ann Łódzka']);
    await step(host, 'host:next'); // q2
    await answer(guest, 0);
    await answer(bride, 2);
    await answer(groom, 2);
    await step(host, 'host:next'); // reveal
    await step(host, 'host:next'); // final
    expect(srv.ctx.rounds[0]!.players).not.toHaveProperty('g002'); // not in the overall ranking
    const record = srv.ctx.archive.get(srv.ctx.archive.list()[0]!.id)!;
    expect(record.players.map((p) => p.id)).toEqual(['g001']);
    expect(record.couple?.map((p) => [p.id, p.role])).toEqual([
      ['g002', 'bride'],
      ['g003', 'groom'],
    ]);

    // the review comes after the full ranking
    expect(await step(host, 'host:coupleNext')).toEqual({ ok: false, error: 'wrong-phase' });
    while (srv.ctx.screen.podiumShown < PODIUM_STEPS) await step(host, 'host:podiumNext');
    await step(host, 'host:showRanking');
    expect(srv.ctx.screen.ranking).toBe(true);
    const slide1 = next(screen, 'state:screen', (v) => v.couple?.n === 1);
    const phone1 = next(guest, 'state:guest', (v) => v.couple?.n === 1);
    expect(await step(host, 'host:coupleNext')).toEqual({ ok: true });
    expect((await slide1).couple).toMatchObject({
      total: 2,
      n: 1,
      question: { id: 'q1', correct: 1 },
      bride: { name: 'Bob Núñez', option: 1 },
      groom: { name: 'Cid Weiß', option: 0 },
    });
    expect((await phone1).couple?.bride?.option).toBe(1); // phones get the same slide
    await step(host, 'host:coupleNext'); // q2
    const summary = next(screen, 'state:screen', (v) => v.couple?.summary !== undefined);
    await step(host, 'host:coupleNext');
    expect((await summary).couple?.summary).toMatchObject({
      bride: { name: 'Bob Núñez', correct: 1 },
      groom: { name: 'Cid Weiß', correct: 0 },
      bothAnswered: 2,
      agreed: 1,
    });
    expect((await summary).couple?.summary?.bride?.wouldRank).toBeGreaterThan(0);
    expect(await step(host, 'host:coupleNext')).toEqual({ ok: false, error: 'wrong-phase' });
    // a new round clears it
    await step(host, 'host:restart');
    expect(srv.ctx.screen.couple).toBeUndefined();
  });

  it('without the switch (or without marked guests) the couple plays like everyone', async () => {
    const { srv, host, bride } = await coupleGame();
    await step(host, 'host:start');
    expect(srv.ctx.quiz.offBoard.size).toBe(0);
    await bride.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'q1' });
    await step(host, 'host:next');
    const v = await next(bride, 'state:guest', (x) => x.phase === 'reveal');
    expect(v.offBoard).toBeUndefined();
    expect(v.rank).toBeDefined();
  });
});

describe('Phase 6.10: question sets, rounds and the overall ranking', () => {
  const round2 = (id: string) => ({
    kind: 'choice' as const,
    text: t(`Round 2 ${id}`),
    options: [t('a'), t('b')],
    correct: 1,
  });

  /** Plays the active set to its final, the guest answering option 1 every time. */
  async function playToFinal(host: Client, guest: Client, srv: AppServer) {
    await step(host, 'host:start');
    for (;;) {
      const id = srv.ctx.quiz.question!.id;
      await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: id });
      await step(host, 'host:next'); // reveal
      await step(host, 'host:next'); // Top 10 or final
      if (srv.ctx.quiz.state.phase === 'final') return;
      await step(host, 'host:next');
    }
  }

  it('a second round plays another set; the overall ranking adds both up', async () => {
    const { url, srv } = await start();
    const { host, guest, admin } = await game(url);
    await playToFinal(host, guest, srv); // round 1: the main quiz
    const first = srv.ctx.quiz.state.players.g001!.score;
    expect(srv.ctx.rounds).toHaveLength(1);

    // back in the waiting room: a new set with one question, picked for round 2
    await step(host, 'host:restart');
    const created = (await host
      .timeout(2000)
      .emitWithAck('host:setCreate', { name: '  Poland   vs Spain ' })) as Ack<{ id: string }>;
    const setId = (created as { id: string }).id;
    expect(setId).toMatch(/^set-/);
    expect(srv.ctx.lists.sets[0]?.name).toBe('Poland vs Spain');
    const saved = (await host.timeout(2000).emitWithAck('host:questionSave', {
      list: setId,
      question: round2('x'),
    })) as Ack<{ id: string }>;
    expect(saved.ok).toBe(true);
    expect((saved as { id: string }).id).toMatch(/^s-/);
    const screen = connect(url, 'screen', admin);
    await next(screen, 'state:screen');
    const named = next(screen, 'state:screen', (v) => v.roundName === 'Poland vs Spain');
    expect(await host.timeout(2000).emitWithAck('host:selectSet', { id: setId })).toEqual({
      ok: true,
    });
    await named;
    expect(srv.ctx.quiz.questions.map((q) => q.id)).toEqual([(saved as { id: string }).id]);
    expect(srv.ctx.quiz.state.players.g001).toBeDefined(); // everyone still joined
    await playToFinal(host, guest, srv);
    const second = srv.ctx.quiz.state.players.g001!.score;
    expect(srv.ctx.rounds.map((r) => r.setName)).toEqual(['Main quiz', 'Poland vs Spain']);
    expect(hostViews.get(host)).toMatchObject({ roundsPlayed: 2, activeSet: setId });
    expect(hostViews.get(host)?.playedSets.sort()).toEqual(['questions', setId].sort());
    // the archive knows which set was played
    expect(srv.ctx.archive.list()).toHaveLength(2);
    const games = srv.ctx.archive.list().map((g) => srv.ctx.archive.get(g.id)!);
    expect(games.map((g) => g.setName ?? 'main').sort()).toEqual(['Poland vs Spain', 'main']);

    // not before the podium is revealed: places are the podium's news (audit 9)
    expect(await host.timeout(2000).emitWithAck('host:showOverall', { on: true })).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
    while (srv.ctx.screen.podiumShown < PODIUM_STEPS) await step(host, 'host:podiumNext');
    // the overall ranking: on the screen and the phones, the phone's own row marked
    const phone = next(guest, 'state:guest', (v) => v.overallRounds === 2);
    const big = next(screen, 'state:screen', (v) => v.overallRounds === 2);
    expect(await host.timeout(2000).emitWithAck('host:showOverall', { on: true })).toEqual({
      ok: true,
    });
    expect((await phone).ranking).toEqual([
      expect.objectContaining({ rank: 1, score: first + second, me: true }),
    ]);
    expect((await big).ranking?.[0]?.score).toBe(first + second);
    // a new round hides it; reset forgets the rounds
    await step(host, 'host:restart');
    expect(srv.ctx.screen.overall).toBe(false);
    // shown again in the waiting room, picking the next round hides it (the lobby announces it)
    await host.timeout(2000).emitWithAck('host:showOverall', { on: true });
    expect(srv.ctx.screen.overall).toBe(true);
    expect(await host.timeout(2000).emitWithAck('host:selectSet', { id: 'questions' })).toEqual({
      ok: true,
    });
    expect(srv.ctx.screen.overall).toBe(false);
    expect(await host.timeout(2000).emitWithAck('host:resetOverall')).toEqual({ ok: true });
    expect(srv.ctx.rounds).toEqual([]);
    expect(await host.timeout(2000).emitWithAck('host:showOverall', { on: true })).toEqual({
      ok: false,
      error: 'wrong-phase',
    });
  });

  it('sets are saved in questions.json; the picked set and the rounds survive a restart', async () => {
    const first = await start();
    const { host } = await game(first.url);
    const created = (await host
      .timeout(2000)
      .emitWithAck('host:setCreate', { name: 'Family photos' })) as Ack<{ id: string }>;
    const setId = (created as { id: string }).id;
    await host
      .timeout(2000)
      .emitWithAck('host:questionSave', { list: setId, question: round2('y') });
    await host.timeout(2000).emitWithAck('host:selectSet', { id: setId });
    first.srv.ctx.rounds.push({ setId, setName: 'Family photos', finishedAt: 1, players: {} });
    await first.srv.ctx.questionWriter.save(first.srv.ctx.lists, first.srv.ctx.timeLimitSec);
    await first.srv.app.close();
    servers.splice(servers.indexOf(first.srv), 1);
    const file = JSON.parse(readFileSync(join(dir, 'questions.json'), 'utf8')) as {
      sets: { id: string; name: string; questions: unknown[] }[];
    };
    expect(file.sets).toMatchObject([{ id: setId, name: 'Family photos' }]);
    const again = await createServer({ ...first.srv.ctx.config }, { logger: false });
    servers.push(again);
    expect(again.ctx.activeSet).toBe(setId);
    expect(again.ctx.quiz.questions).toHaveLength(1);
    expect(again.ctx.rounds).toHaveLength(1);
  });

  it('checks set actions: names, unknown sets, the waiting room only; deleting the picked set', async () => {
    const { url, srv } = await start();
    const { host } = await game(url);
    const ack = (event: string, payload?: unknown) =>
      host.timeout(2000).emitWithAck(event as 'host:setRename', payload as never);
    for (const name of ['', '   ', 'x'.repeat(41), 5]) {
      expect(await ack('host:setCreate', { name })).toEqual({ ok: false, error: 'invalid-input' });
    }
    expect(await ack('host:setRename', { id: 'set-nope', name: 'x' })).toEqual({
      ok: false,
      error: 'unknown-set',
    });
    for (const id of ['warmup', 'set-nope', '__proto__']) {
      expect(await ack('host:selectSet', { id })).toEqual({ ok: false, error: 'unknown-set' });
    }
    const created = (await ack('host:setCreate', { name: 'Songs' })) as { id: string };
    // one name per list, so the Round picker never shows two alike (case and accents ignored)
    for (const name of ['sóngs', 'SONGS', 'Main quiz', 'warm-up', 'Son\u200bgs']) {
      expect(await ack('host:setCreate', { name })).toEqual({ ok: false, error: 'duplicate-name' });
    }
    const other = (await ack('host:setCreate', { name: 'Films' })) as { id: string };
    expect(await ack('host:setRename', { id: other.id, name: 'Songs' })).toEqual({
      ok: false,
      error: 'duplicate-name',
    });
    expect(await ack('host:setRename', { id: created.id, name: 'songs' })).toEqual({ ok: true });
    expect(await ack('host:setDelete', { id: other.id })).toEqual({ ok: true });
    await ack('host:questionSave', { list: created.id, question: round2('z') });
    // a Start tapped on a panel that still showed the old round is refused (audit 9)
    const before = srv.ctx.round;
    await ack('host:selectSet', { id: created.id });
    expect(srv.ctx.round).toBe(before + 1);
    expect(await ack('host:setDelete', { id: created.id })).toEqual({ ok: true });
    expect(srv.ctx.activeSet).toBe('questions'); // back to the main quiz
    expect(srv.ctx.quiz.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    await step(host, 'host:start');
    expect(await ack('host:setCreate', { name: 'Later' })).toEqual({
      ok: false,
      error: 'editing-locked',
    });
    expect(await ack('host:selectSet', { id: 'questions' })).toEqual({
      ok: false,
      error: 'editing-locked',
    });
  });

  it('refuses a questions.json with bad sets or a question id used twice', async () => {
    const bad = (sets: unknown) =>
      writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, sets }));
    bad([{ id: 'nope', name: 'x', questions: [] }]);
    await expect(start()).rejects.toThrow(/id missing, invalid or used twice/);
    bad([{ id: 'set-ab12', name: 'x', questions: [{ ...questions[0], id: 'q1' }] }]);
    await expect(start()).rejects.toThrow(/question id "q1" is used twice/);
    bad([{ id: 'set-ab12', name: '', questions: [] }]);
    await expect(start()).rejects.toThrow(/name missing/);
  });

  it('the warm-up ends with its own podium (never saved)', async () => {
    const warmup = questions.map((x) => ({ ...x, id: `w-${x.id}` }));
    writeFileSync(join(dir, 'questions.json'), JSON.stringify({ questions, warmup }));
    const { url, srv } = await start();
    const { host, guest } = await game(url);
    await step(host, 'host:startWarmup');
    await guest.timeout(2000).emitWithAck('quiz:answer', { option: 1, questionId: 'w-q1' });
    await step(host, 'host:next');
    await step(host, 'host:next');
    await step(host, 'host:next');
    await step(host, 'host:skip'); // the warm-up's final
    expect((await next(guest, 'state:guest')).rankHidden).toBe(true);
    const placed = next(guest, 'state:guest', (v) => v.rank === 1);
    expect(await step(host, 'host:podiumNext')).toEqual({ ok: true });
    await placed;
    expect(await step(host, 'host:endWarmup')).toEqual({ ok: true });
    expect(srv.ctx.screen.podiumShown).toBe(0);
    expect(srv.ctx.archive.list()).toEqual([]);
    expect(srv.ctx.rounds).toEqual([]);
  });
});

describe('the public demo (DEMO_MODE)', () => {
  it('shows the password and one-tap logins on the login page, only in the demo', async () => {
    const { url } = await start({ demo: true });
    const page = await (await fetch(`${url}/login`)).text();
    expect(page).toContain('Public demo');
    expect(page).toContain(`<code>${PASSWORD}</code>`);
    expect(page.match(/name="next" value="\/(host|screen)"/g)).toHaveLength(3); // 2 demo + the form
    const { url: real } = await start();
    expect(await (await fetch(`${real}/login`)).text()).not.toContain(PASSWORD);
  });

  it('starts with joining open, so a visitor phone joins at once', async () => {
    const { srv } = await start({ demo: true });
    expect(srv.ctx.joiningOpen).toBe(true);
  });

  it('refuses photo uploads in the demo', async () => {
    const { url } = await start({ demo: true });
    const res = await fetch(`${url}/host/photos`, {
      method: 'POST',
      headers: { 'content-type': 'image/webp', cookie: cookieOf(await login(url)) },
      body: Buffer.from('RIFF0000WEBPVP8 '),
    });
    expect(res.status).toBe(403);
  });

  it('demo players join and answer by themselves; outside the demo they are refused', async () => {
    const { url: real } = await start();
    const realHost = connect(real, 'host', cookieOf(await login(real)));
    await next(realHost, 'state:host');
    expect(await realHost.timeout(2000).emitWithAck('host:addBots')).toEqual({
      ok: false,
      error: 'forbidden',
    });

    const { url, srv } = await start({ demo: true });
    const { host } = await game(url);
    expect(hostViews.get(host)?.demo).toBe(true);
    const counted = next(host, 'state:host', (v) => v.playerCount === 9);
    expect(await host.timeout(2000).emitWithAck('host:addBots')).toEqual({ ok: true, added: 8 });
    await counted; // 8 demo players + the real guest
    // adding again adds nobody new (same names)
    expect(await host.timeout(2000).emitWithAck('host:addBots')).toEqual({ ok: true, added: 0 });
    expect(await step(host, 'host:start')).toEqual({ ok: true });
    await next(host, 'state:host', (v) => v.phase === 'question' && v.answeredCount === 8);
    expect(Object.keys(srv.ctx.quiz.state.answers)).toHaveLength(8); // only the real guest left
  });
});

describe('switching between the demo and the real event', () => {
  const EVENT_PW = 'the-real-event-password';
  const eventDir = () => join(dir, 'event');
  const flag = () => join(eventDir(), 'EVENT_MODE');
  function eventContent() {
    mkdirSync(join(eventDir(), 'content'), { recursive: true });
    writeFileSync(join(eventDir(), 'content/questions.json'), JSON.stringify({ questions }));
    writeFileSync(join(eventDir(), 'content/guests.json'), JSON.stringify({ guests }));
    writeFileSync(join(eventDir(), 'content/event.json'), JSON.stringify(EVENT));
  }

  it('the event password switches the demo to the event, logged in, after a restart', async () => {
    eventContent();
    const restart = vi.fn();
    const { url } = await start({
      demo: true,
      eventPassword: EVENT_PW,
      eventDir: eventDir(),
      restart,
    });
    const res = await login(url, EVENT_PW);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Starting the event');
    expect(cookieOf(res)).toMatch(/^ido_admin=/); // valid for the event after the restart
    expect(existsSync(flag())).toBe(true);
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    // the demo password still opens the demo (until the restart)
    expect((await login(url)).status).toBe(303);
  });

  it('refuses to switch when the event content is missing or broken (no flag, no restart)', async () => {
    const restart = vi.fn();
    mkdirSync(eventDir(), { recursive: true });
    const { url } = await start({
      demo: true,
      eventPassword: EVENT_PW,
      eventDir: eventDir(),
      restart,
    });
    const missing = await login(url, EVENT_PW);
    expect(missing.status).toBe(409);
    expect(await missing.text()).toContain('questions.json is missing');
    eventContent();
    writeFileSync(join(eventDir(), 'content/event.json'), '{ broken');
    expect((await login(url, EVENT_PW)).status).toBe(409);
    expect(existsSync(flag())).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(restart).not.toHaveBeenCalled();
  });

  it('the event: no demo box, no demo players; ending it goes back to the demo', async () => {
    eventContent();
    writeFileSync(flag(), 'on');
    const restart = vi.fn();
    // (a server started in event mode: its admin password is the event password)
    const { url } = await start({ event: true, eventDir: eventDir(), restart });
    expect(await (await fetch(`${url}/login`)).text()).not.toContain('Public demo');
    const host = connect(url, 'host', cookieOf(await login(url)));
    await next(host, 'state:host');
    expect(hostViews.get(host)?.event).toBe(true);
    expect(await host.timeout(2000).emitWithAck('host:addBots')).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await host.timeout(2000).emitWithAck('host:endEvent')).toEqual({ ok: true });
    expect(existsSync(flag())).toBe(false);
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
  });

  it('outside the event there is nothing to end', async () => {
    const { url } = await start({ demo: true });
    const host = connect(url, 'host', cookieOf(await login(url)));
    await next(host, 'state:host');
    expect(await host.timeout(2000).emitWithAck('host:endEvent')).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });
});
