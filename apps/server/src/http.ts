// Admin login, the join link and the gate that keeps the site closed without one of them.
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE_SEC,
  adminToken,
  cookie,
  GUEST_COOKIE,
  GUEST_MAX_AGE_SEC,
  guestToken,
  LoginLimiter,
  newId,
  safeEqual,
} from './auth';
import { JOIN_PATH } from '@idoknow/shared';
import { gameCsv, isGameId } from './archive';
import { eventContentProblem, setEventFlag } from './demo';
import { identify } from './sessions';
import type { AppContext } from './server';

/**
 * Paths that need no login. /socket.io is handled by Socket.IO (it checks cookies itself).
 * The join link is open to everyone: what it lets a device do is decided per action (the
 * host's joining switch, names only from the guest list, rate limits).
 */
const OPEN = new Set(['/health', '/login', '/logout', JOIN_PATH]);
/** Logos and fonts: nothing private. */
const PUBLIC_FILE = /^\/(brand|fonts)\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(webp|png|woff2|txt)$/;

/**
 * The client's IP for a raw request (Socket.IO handshakes don't go through Fastify). Behind the
 * trusted proxy (Caddy), the last X-Forwarded-For entry is the one the proxy added itself, so a
 * client can't fake it; without a trusted proxy the header is ignored.
 */
export function clientIp(
  req: {
    headers: Record<string, string | string[] | undefined>;
    socket: { remoteAddress?: string };
  },
  trustProxy: boolean | string,
): string {
  const remote = req.socket.remoteAddress ?? '';
  // like Fastify: TRUST_PROXY=true trusts any proxy; a list of IPs trusts only those
  // (exact addresses here; CIDR ranges aren't supported for sockets)
  const trusted =
    trustProxy === true ||
    (typeof trustProxy === 'string' &&
      trustProxy
        .split(',')
        .map((ip) => ip.trim())
        .includes(remote.replace(/^::ffff:/i, '')));
  const forwarded = req.headers['x-forwarded-for'];
  const last = trusted
    ? (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').at(-1)?.trim()
    : undefined;
  return last || remote || 'unknown';
}

/** A request from another site (e.g. a hidden form elsewhere posting to /login) is refused. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true; // same-origin GETs and non-browser clients send none
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · I Do! (know)</title>
<link rel="icon" type="image/png" href="/brand/icon-64.png">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121833;color:#f7f1e6;font:16px/1.45 'Segoe UI',system-ui,sans-serif}
main{width:min(360px,calc(100% - 32px));padding:32px 24px;border-radius:24px;background:#1b2347;text-align:center}
h1{margin:0 0 16px;font:600 32px Georgia,serif;color:#d8b36a}
p{margin:0 0 16px;color:#c9c3d9}.err{color:#d4626c}.guests p{margin:0 0 8px;color:#f7f1e6;font-size:17px}
.join{display:block;margin-top:12px;padding:14px;border-radius:10px;background:#27315c;color:#d8b36a;font-weight:700;text-decoration:none}
.organizer{margin:24px 0 8px;font-size:14px;color:#8d89a6;text-transform:uppercase;letter-spacing:.1em}
input,button{width:100%;box-sizing:border-box;padding:14px;border-radius:10px;border:0;font:inherit}
input{margin-bottom:12px;background:#27315c;color:#f7f1e6}
button{background:#d8b36a;color:#1b1d33;font-weight:700;cursor:pointer}
.demo{margin-bottom:24px;padding:16px;border-radius:14px;background:#27315c;text-align:left}.demo p{font-size:15px}.demo form{margin-bottom:10px}.demo .pw{margin:4px 0 0;font-size:14px}code{color:#d8b36a}
</style></head><body><main><h1>I Do! (know)</h1>${body}</main></body></html>`;

/**
 * For guests who ended up on the organizer login: the way to the quiz, in all five languages
 * (fixed texts only, never anything from a request).
 */
const GUESTS_JOIN = `<div class="guests">${[
  ['en', 'Guests: join the quiz here'],
  ['pl', 'Goście: dołączcie do quizu tutaj'],
  ['es', 'Invitados: uníos al quiz aquí'],
  ['ca', 'Convidats: uniu-vos al quiz aquí'],
  ['de', 'Gäste: hier geht es zum Quiz'],
]
  .map(([lang, text]) => `<p lang="${lang}">${text}</p>`)
  .join('')}<a class="join" href="${JOIN_PATH}">→ ${JOIN_PATH}</a></div>`;

/** For a browser that doesn't keep cookies: the phone can't stay in the quiz without one. */
const cookiesPage = () =>
  page(
    'Cookies',
    `<div class="guests">${[
      [
        'en',
        'This browser does not keep cookies, so the quiz cannot remember your phone. Please allow cookies (or leave private mode) and open the link again.',
      ],
      [
        'pl',
        'Ta przeglądarka nie zapisuje plików cookie, więc quiz nie zapamięta Twojego telefonu. Zezwól na cookie (lub wyjdź z trybu prywatnego) i otwórz link ponownie.',
      ],
      [
        'es',
        'Este navegador no guarda cookies, así que el quiz no puede recordar tu móvil. Permite las cookies (o sal del modo privado) y vuelve a abrir el enlace.',
      ],
      [
        'ca',
        "Aquest navegador no desa galetes, així que el quiz no pot recordar el teu mòbil. Permet les galetes (o surt del mode privat) i torna a obrir l'enllaç.",
      ],
      [
        'de',
        'Dieser Browser speichert keine Cookies, daher kann sich das Quiz dein Handy nicht merken. Bitte erlaube Cookies (oder verlasse den privaten Modus) und öffne den Link erneut.',
      ],
    ]
      .map(([lang, text]) => `<p lang="${lang}">${text}</p>`)
      .join('')}<a class="join" href="${JOIN_PATH}">→ ${JOIN_PATH}</a></div>`,
  );

/** Where the login leads: only these pages (never a link from outside, e.g. /login?next=//evil). */
const AFTER_LOGIN = new Set(['/host', '/screen']);
const afterLogin = (next: unknown): string =>
  typeof next === 'string' && AFTER_LOGIN.has(next) ? next : '/host';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The public demo: the password is public on purpose (the demo has only example data and
 * resets every night), with one-tap logins to the host panel and the big screen.
 */
const demoBox = (password: string) => {
  const p = escapeHtml(password);
  const open = (next: string, label: string) =>
    `<form method="post" action="/login"><input type="hidden" name="next" value="${next}"><input type="hidden" name="password" value="${p}"><button type="submit">${label}</button></form>`;
  return `<div class="demo"><p><b>Public demo</b> with a made-up couple and guests. Everything resets every night.</p>
<p>Open the host panel and the big screen (best in two windows), then join as a guest on your phone or in a private window. In the host panel you can add demo players who answer by themselves.</p>
${open('/host', 'Open the host panel')}${open('/screen', 'Open the big screen')}
<p class="pw">Password: <code>${p}</code></p></div>`;
};

/** After the event password: the server restarts as the event; the login comes back by itself. */
const switchingPage = page(
  'Starting the event',
  `<meta http-equiv="refresh" content="8;url=/host"><p>Starting the event… The host panel opens in a few seconds.</p>`,
);

const loginPage = (error?: string, next = '/host', demoPassword?: string) =>
  page(
    'Login',
    `${demoPassword ? demoBox(demoPassword) : ''}${GUESTS_JOIN}<p class="organizer">Organizer</p>${error ? `<p class="err">${error}</p>` : ''}<form method="post" action="/login">
<input type="hidden" name="next" value="${afterLogin(next)}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
<button type="submit">Log in</button></form>`,
  );

function html(reply: FastifyReply, code: number, body: string) {
  return reply
    .code(code)
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(body);
}

/** Photo uploads: at most this big (the host panel sends about 100–300 KB). */
export const PHOTO_MAX_BYTES = 1_500_000;
/** Accepted upload types and the file extension each one gets. */
const PHOTO_TYPES: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** What an image really is, from its first bytes (never trust the name or the header alone). */
export function imageType(bytes: Buffer): 'webp' | 'jpg' | 'png' | undefined {
  if (bytes.length < 16) return undefined;
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return undefined;
}

export function registerHttp(app: FastifyInstance, ctx: AppContext): void {
  const limiter = new LoginLimiter();
  const demoPassword = ctx.config.demo ? ctx.config.adminPassword : undefined;
  const who = (request: FastifyRequest) => identify(request.headers.cookie, ctx.config, ctx.now());
  const secure = (request: FastifyRequest) => request.protocol === 'https';
  const guestCookie = (request: FastifyRequest, sid: string) =>
    cookie(
      GUEST_COOKIE,
      guestToken(sid, ctx.now(), ctx.config.sessionSecret),
      GUEST_MAX_AGE_SEC,
      secure(request),
    );

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    // no other site may frame our pages; only the question editor frames its own preview page
    const path = request.url.split('?')[0];
    reply.header('X-Frame-Options', path === '/preview' ? 'SAMEORIGIN' : 'DENY');
    // our addresses are nobody else's business
    reply.header('Referrer-Policy', 'same-origin');
  });

  // The gate: admin sees everything; a guest only /play and static files; everyone else logs in.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (OPEN.has(path) || PUBLIC_FILE.test(path)) return;
    const id = who(request);
    if (id.admin) return;
    const isPage = extname(path) === '' && !path.startsWith('/assets/');
    if (id.sid) {
      // quiz photos are private family pictures (and would spoil the photo questions): only for
      // guests who picked a name, not for any device that merely opened the public join link
      if (path.startsWith('/photos/') && !ctx.sessions.guestOf(id.sid)) {
        return reply.code(401).send({ error: 'Pick your name first' });
      }
      if (path === '/play') {
        // keep the device's identity alive (e.g. from the rehearsal until the wedding)
        reply.header('Set-Cookie', guestCookie(request, id.sid));
        return;
      }
      if (!isPage) return;
      return reply.redirect('/play');
    }
    if (isPage && request.method === 'GET') {
      // guests (the phone page, or just the domain typed in) go to the join link, not the login
      if (path === '/play' && new URLSearchParams(request.url.split('?')[1]).has('j')) {
        // just came from /join and still has no cookie: the browser doesn't keep cookies (a
        // loop /join → /play → /join would end in "too many redirects")
        return html(reply, 400, cookiesPage());
      }
      if (path === '/play' || path === '/') return reply.redirect(JOIN_PATH);
      return reply.redirect(path === '/screen' ? '/login?next=/screen' : '/login');
    }
    return reply.code(401).send({ error: 'Login required' });
  });

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_request, body, done) => done(null, new URLSearchParams(body as string)),
  );

  app.get<{ Querystring: { next?: unknown } }>('/login', (request, reply) => {
    const next = afterLogin(request.query.next);
    return who(request).admin
      ? reply.redirect(next)
      : html(reply, 200, loginPage(undefined, next, demoPassword));
  });

  app.post('/login', (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) {
      return html(reply, 403, loginPage('Please log in from this page.'));
    }
    const now = ctx.now();
    if (limiter.blocked(request.ip, now)) {
      return html(reply, 429, loginPage('Too many attempts. Please wait 15 minutes.'));
    }
    const body = request.body instanceof URLSearchParams ? request.body : undefined;
    const password = body?.get('password') ?? '';
    const next = afterLogin(body?.get('next'));
    // the demo's switch to the real event: checked first, then the server restarts as the event
    if (
      ctx.config.demo &&
      ctx.config.eventPassword &&
      ctx.config.eventDir &&
      safeEqual(password, ctx.config.eventPassword)
    ) {
      const problem = eventContentProblem(ctx.config.eventDir);
      if (problem) {
        request.log.error({ problem }, 'switch to the event refused');
        return html(reply, 409, loginPage(`The event can't start: ${escapeHtml(problem)}`, next));
      }
      try {
        setEventFlag(ctx.config.eventDir, true);
      } catch (e) {
        request.log.error(e, 'writing the event flag failed');
        return html(
          reply,
          500,
          loginPage("The event can't start: the event folder isn't writable."),
        );
      }
      request.log.warn({ ip: request.ip }, 'switching to the event');
      setTimeout(ctx.restart, 300); // after the reply
      // the event's admin password IS the event password: this cookie works after the restart
      reply.header(
        'Set-Cookie',
        cookie(
          ADMIN_COOKIE,
          adminToken(now, ctx.config.sessionSecret, ctx.config.eventPassword),
          ADMIN_MAX_AGE_SEC,
          secure(request),
        ),
      );
      return html(reply, 200, switchingPage);
    }
    if (!safeEqual(password, ctx.config.adminPassword)) {
      limiter.fail(request.ip, now);
      request.log.warn({ ip: request.ip }, 'failed admin login');
      return html(reply, 401, loginPage('Wrong password.', next, demoPassword));
    }
    request.log.info({ ip: request.ip }, 'admin login');
    return reply
      .header(
        'Set-Cookie',
        cookie(
          ADMIN_COOKIE,
          adminToken(now, ctx.config.sessionSecret, ctx.config.adminPassword),
          ADMIN_MAX_AGE_SEC,
          secure(request),
        ),
      )
      .redirect(next, 303);
  });

  // Question editor: a photo for a photo question. The host panel shrinks it first (about
  // 1200 px WebP); the server only accepts real, small images and picks a neutral file name
  // (a name must never give the answer away).
  // (in its own plugin scope: the image parser and its 1.5 MB limit exist on this route only)
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      Object.keys(PHOTO_TYPES),
      { parseAs: 'buffer', bodyLimit: PHOTO_MAX_BYTES },
      (_request, body, done) => done(null, body),
    );
    scope.post('/host/photos', { bodyLimit: PHOTO_MAX_BYTES }, async (request, reply) => {
      if (!who(request).admin) return reply.code(401).send({ error: 'Login required' });
      if (ctx.config.demo)
        return reply.code(403).send({ error: 'Photo uploads are off in the demo' });
      if (!isSameOrigin(request.headers.origin, request.headers.host)) {
        return reply.code(403).send({ error: 'Wrong origin' });
      }
      const body = request.body;
      const ext = Buffer.isBuffer(body) ? imageType(body) : undefined;
      if (!ext || ext !== PHOTO_TYPES[String(request.headers['content-type'])]) {
        return reply.code(415).send({ error: 'Only WebP, JPEG or PNG images' });
      }
      const dir = join(ctx.config.contentDir, 'photos');
      const name = `photo-${newId(8)
        .replace(/[^A-Za-z0-9]/g, '')
        .slice(0, 10)}.${ext}`;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), body as Buffer, { flag: 'wx' }); // never over an existing file
      request.log.info({ name, bytes: (body as Buffer).length }, 'photo uploaded');
      return { name };
    });
    done();
  });

  // The game archive as files to download (host only): JSON as saved, CSV for a spreadsheet.
  app.get<{ Params: { file: string } }>('/host/games/:file', (request, reply) => {
    if (!who(request).admin) return reply.code(401).send({ error: 'Login required' });
    const m = /^(.+)\.(json|csv)$/.exec(request.params.file);
    const game = m && isGameId(m[1]) ? ctx.archive.get(m[1]) : undefined;
    if (!m || !game) return reply.code(404).send({ error: 'Not found' });
    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="idoknow-${game.id}.${m[2]}"`)
      .type(m[2] === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .send(m[2] === 'csv' ? gameCsv(game) : JSON.stringify(game, null, 2));
  });

  app.post('/logout', (request, reply) => {
    if (!isSameOrigin(request.headers.origin, request.headers.host)) return reply.code(403).send();
    return reply
      .header('Set-Cookie', cookie(ADMIN_COOKIE, '', 0, secure(request)))
      .redirect('/login', 303);
  });

  // The join link (QR code, stickers, typed). Stores nothing on the server (see guestToken): a
  // device gets a session id in its cookie and picks a name on /play when joining is open. A
  // device that already has one keeps it. Admins get a guest cookie too (testing on one PC).
  app.get(JOIN_PATH, (request, reply) => {
    const sid = who(request).sid ?? newId();
    // "?j": /play can tell a browser that refuses cookies apart from a first visit (see the gate)
    return reply.header('Set-Cookie', guestCookie(request, sid)).redirect('/play?j', 303);
  });
}
