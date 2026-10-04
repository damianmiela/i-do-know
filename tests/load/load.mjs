// Load test (Phase 10): N simulated guests play a whole game against the production build.
//
//   npm run build
//   npm run test:load            (200 guests; LOAD_GUESTS=300 npm run test:load for more)
//
// It starts its own server on a free port with the example questions, a generated guest list,
// a throwaway admin password and temp folders: the real content/, data/ and .env are never used.
// Every guest has its own address (X-Forwarded-For, TRUST_PROXY=true on this test server only),
// like 200 phones; it opens the join link, searches and claims its name, answers every question
// after a random delay, and must receive every screen. Measured: how long until ALL guests see
// each new step (that is what the room experiences), answer replies, and lost answers.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { io } from 'socket.io-client';

const ROOT = resolve(import.meta.dirname, '../..');
const GUESTS = Number(process.env.LOAD_GUESTS || 200);
const PASSWORD = `load-test-${Math.random().toString(36).slice(2)}`;
const ANSWER_DELAY_MS = [500, 6_000]; // like real people: some fast, some slow

const freePort = () =>
  new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN;
};
const ms = (x) => `${Math.round(x)} ms`;

// ---------- a private test instance ----------
const work = mkdtempSync(join(tmpdir(), 'idoknow-load-'));
const content = join(work, 'content');
mkdirSync(join(content, 'photos'), { recursive: true });
for (const f of ['questions.example.json', 'event.example.json']) {
  copyFileSync(join(ROOT, 'content', f), join(content, f.replace('.example', '')));
}
copyFileSync(
  join(ROOT, 'content/photos/example-baby.webp'),
  join(content, 'photos/example-baby.webp'),
);
const countries = ['PL', 'ES', 'DE'];
const guestList = Array.from({ length: GUESTS }, (_, i) => ({
  id: `g${String(i + 1).padStart(3, '0')}`,
  name: `Loadguest${String(i + 1).padStart(3, '0')} Test`,
  country: countries[i % 3],
  side: i % 2 ? 'groom' : 'bride',
}));
writeFileSync(join(content, 'guests.json'), JSON.stringify({ guests: guestList }));

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    ADMIN_PASSWORD: PASSWORD,
    SESSION_SECRET: `${Math.random().toString(36)}${'x'.repeat(40)}`,
    PORT: String(port),
    HOST: '127.0.0.1',
    TRUST_PROXY: 'true',
    CONTENT_DIR: content,
    DATA_DIR: join(work, 'data'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => (serverErr += d));

const sockets = [];
let failed = false;
function finish(code) {
  for (const s of sockets) s.disconnect();
  server.kill();
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => finish(130));

for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {
    if (i > 80) {
      console.error('The test server did not start:\n' + serverErr);
      finish(1);
    }
    await sleep(250);
  }
}

const cookieOf = (res, name) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith(`${name}=`));

function connect(view, cookie, ip) {
  const s = io(BASE, {
    auth: { view },
    transports: ['websocket'],
    extraHeaders: { cookie, origin: BASE, 'x-forwarded-for': ip },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const ask = (s, event, payload) =>
  new Promise((ok) => {
    const t0 = performance.now();
    const done = (r) => ok({ ...r, ms: performance.now() - t0 });
    if (payload === undefined)
      s.timeout(10_000).emit(event, (e, r) => done(e ? { ok: false, error: 'timeout' } : r));
    else
      s.timeout(10_000).emit(event, payload, (e, r) =>
        done(e ? { ok: false, error: 'timeout' } : r),
      );
  });

// ---------- the host ----------
const login = await fetch(`${BASE}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
  body: new URLSearchParams({ password: PASSWORD, next: '/host' }),
  redirect: 'manual',
});
const hostCookie = cookieOf(login, 'ido_admin');
if (!hostCookie) {
  console.error('Admin login failed');
  finish(1);
}
let hostView;
const hostLog = []; // when the host got each view: the reference for the auto-reveal
const host = connect('host', hostCookie, '10.255.255.1');
host.on('state:host', (v) => {
  hostView = v;
  hostLog.push({ at: performance.now(), v });
});
await new Promise((ok) => host.once('state:host', ok));
const opened = await ask(host, 'host:setJoining', { open: true });
if (!opened.ok) {
  console.error('Opening joining failed', opened);
  finish(1);
}

// ---------- the guests join ----------
const guests = [];
const errors = [];
const joinStart = performance.now();
await Promise.all(
  guestList.map(async (g, i) => {
    const ip = `10.${(i >> 8) & 255}.${i & 255}.${7 + (i % 200)}`;
    const res = await fetch(`${BASE}/join`, {
      redirect: 'manual',
      headers: { 'x-forwarded-for': ip },
    });
    const cookie = cookieOf(res, 'ido_guest');
    if (!cookie) return errors.push(`${g.id}: no guest cookie from /join (${res.status})`);
    const s = connect('play', cookie, ip);
    const guest = { g, s, views: [], answers: 0, answerMs: [] };
    s.on('state:guest', (v) => guest.views.push({ at: performance.now(), v }));
    await new Promise((ok, no) => {
      s.once('connect', ok);
      s.once('connect_error', no);
    }).catch((e) => errors.push(`${g.id}: connect failed (${e.message})`));
    const found = await ask(s, 'guest:search', { query: g.name.split(' ')[0] });
    const me = found.ok && found.results.find((r) => r.id === g.id);
    if (!me)
      return errors.push(`${g.id}: search did not find the name (${found.error ?? 'no match'})`);
    const claimed = await ask(s, 'guest:claim', { guestId: g.id });
    if (!claimed.ok) return errors.push(`${g.id}: claim failed (${claimed.error})`);
    guests.push(guest);
  }),
);
const joinMs = performance.now() - joinStart;
await sleep(500);
const joinedOk = hostView.joinedGuests === GUESTS && guests.length === GUESTS;

// ---------- the quiz ----------
/** Host step action; returns when the host has the reply. */
async function step(event) {
  const r = await ask(host, event, { at: hostView.step });
  if (!r.ok) throw new Error(`${event} refused: ${r.error}`);
  return r;
}
/** Waits until every guest has received a view that passes `test` after `since`; returns delays. */
async function fanOut(since, test, label, timeoutMs = 15_000) {
  const t0 = performance.now();
  for (;;) {
    const got = guests.map((x) => x.views.find((e) => e.at >= since && test(e.v)));
    if (got.every(Boolean)) return got.map((e) => e.at - since);
    if (performance.now() - t0 > timeoutMs) {
      const missing = got.filter((x) => !x).length;
      throw new Error(`${label}: ${missing} of ${guests.length} guests never got it`);
    }
    await sleep(20);
  }
}
const fan = []; // { label, delays }
const until = async (test, label, timeoutMs = 90_000) => {
  const t0 = performance.now();
  while (!test(hostView)) {
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(50);
  }
};

try {
  let t = performance.now();
  await step('host:start');
  const questionCount = hostView.questionCount;
  for (let n = 1; n <= questionCount; n++) {
    if (n > 1) {
      t = performance.now();
      await step('host:next'); // from the Top 10 to the next question
    }
    fan.push({
      label: `question ${n} appears`,
      delays: await fanOut(t, (v) => v.phase === 'question' && v.questionNumber === n, `q${n}`),
    });
    if (hostView.reading) {
      t = performance.now();
      await step('host:showAnswers');
      fan.push({
        label: `question ${n}: answers shown`,
        delays: await fanOut(t, (v) => v.phase === 'question' && !v.reading, `q${n} answers`),
      });
    }
    const q = hostView.question;
    // everyone answers after a human-like delay
    await Promise.all(
      guests.map(async (x) => {
        await sleep(ANSWER_DELAY_MS[0] + Math.random() * (ANSWER_DELAY_MS[1] - ANSWER_DELAY_MS[0]));
        const r = await ask(x.s, 'quiz:answer', {
          option: Math.floor(Math.random() * q.options.length),
          questionId: q.id,
        });
        x.answerMs.push(r.ms);
        if (r.ok) x.answers++;
        else errors.push(`${x.g.id}: answer to ${q.id} refused (${r.error})`);
      }),
    );
    // auto-reveal: everyone answered → the answer shows by itself (measured from the moment the
    // host panel got it: the server sends it to everyone at once)
    await until((v) => v.phase === 'reveal', `the reveal of question ${n}`);
    const revealAt = hostLog.find((e) => e.v.phase === 'reveal' && e.v.questionNumber === n).at;
    fan.push({
      label: `question ${n}: auto-reveal reaches everyone`,
      delays: (
        await fanOut(
          revealAt - 1_000,
          (v) => v.phase === 'reveal' && v.questionNumber === n,
          `reveal ${n}`,
        )
      ).map((d) => Math.max(0, d - 1_000)),
    });
    if (hostView.answeredCount !== GUESTS) {
      errors.push(
        `question ${n}: the server counted ${hostView.answeredCount} of ${GUESTS} answers`,
      );
    }
    t = performance.now();
    await step('host:next'); // Top 10, or the podium after the last question
    fan.push({
      label: n < questionCount ? `Top 10 after question ${n}` : 'final',
      delays: await fanOut(
        t,
        (v) => v.phase === (n < questionCount ? 'leaderboard' : 'final'),
        `after ${n}`,
      ),
    });
  }
  for (let i = 0; i < 3; i++) await step('host:podiumNext');
  t = performance.now();
  await step('host:showRanking');
  fan.push({
    label: 'full ranking on every phone',
    delays: await fanOut(
      t,
      (v) => Array.isArray(v.ranking) && v.ranking.some((r) => r.me),
      'ranking',
    ),
  });
  const last = guests.map((x) => x.views.at(-1).v);
  const ranks = last.map((v) => v.rank).filter((r) => typeof r === 'number');
  if (ranks.length !== GUESTS)
    errors.push(`only ${ranks.length} of ${GUESTS} phones got a final place`);
} catch (e) {
  failed = true;
  errors.push(e.message);
}

// ---------- report ----------
const answerMs = guests.flatMap((x) => x.answerMs);
const lost = guests.reduce((n, x) => n + (hostView.questionCount - x.answers), 0);
console.log(`\nLoad test: ${GUESTS} guests, ${hostView.questionCount} questions\n`);
console.log(
  `joined: ${guests.length}/${GUESTS} in ${ms(joinMs)}${joinedOk ? '' : '  <-- NOT ALL'}`,
);
console.log(
  `answers: ${answerMs.length} sent, lost ${lost}; reply p50 ${ms(pct(answerMs, 50))}, p95 ${ms(pct(answerMs, 95))}, max ${ms(Math.max(...answerMs))}`,
);
console.log('\nuntil EVERY phone shows the new step (p50 / p95 / slowest):');
for (const f of fan) {
  console.log(
    `  ${f.label.padEnd(42)} ${ms(pct(f.delays, 50)).padStart(7)} ${ms(pct(f.delays, 95)).padStart(7)} ${ms(Math.max(...f.delays)).padStart(7)}`,
  );
}
const worst = Math.max(...fan.flatMap((f) => f.delays));
if (errors.length)
  console.log(`\nproblems (${errors.length}):\n- ${errors.slice(0, 20).join('\n- ')}`);
const ok = !failed && joinedOk && lost === 0 && errors.length === 0 && worst < 2_000;
console.log(
  `\n${ok ? 'PASS' : 'FAIL'} (limits: everyone joins, no lost answers, every step on every phone within 2 s)`,
);
finish(ok ? 0 : 1);
