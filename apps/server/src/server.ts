// Builds the whole server (HTTP + Socket.IO + game) without starting it, so tests can run it too.
import { existsSync, mkdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { EventInfo, Lang, PastOnScreen, RoundResult } from '@idoknow/shared';
import { GameArchive } from './archive';
import { loadEvent, loadGuests, loadQuestions } from './content';
import type { Config } from './env';
import type { Collect } from './game/collect';
import { BOT_ANSWER_MS } from './game/config';
import { PHOTO_NAME, type Quiz } from './game/quiz';
import type { GuestBook } from './guests';
import { registerHttp } from './http';
import { listOf, QuestionWriter, type QuestionLists } from './questionStore';
import { attachRealtime, type Realtime } from './realtime';
import type { SessionStore } from './sessions';
import { loadGame, SNAPSHOT_VERSION, SnapshotWriter } from './snapshot';

/** The host's warning while content/questions.json couldn't be written. */
export const QUESTIONS_SAVE_FAILED =
  "Saving content/questions.json failed: the last question changes and the timer are only in memory. Don't start the quiz before this is fixed (a restart would lose them and could send a running quiz back to the waiting room).";

/** Everything the HTTP routes and socket handlers work with. */
export interface AppContext {
  config: Config;
  quiz: Quiz;
  collect: Collect;
  /** The warm-up round being played (null = the real quiz). */
  warmup: { quiz: Quiz | null };
  /**
   * Every question list: the main quiz, the warm-up and the extra sets (Phase 6.10). The real
   * quiz plays `activeSet`'s list; only the question editor changes them.
   */
  lists: QuestionLists;
  /** The list the real quiz plays (MAIN_SET or a set id; saved). */
  activeSet: string;
  /** Rounds played to the end, for the overall ranking (saved). */
  rounds: RoundResult[];
  /**
   * The big screen: its language (host's choice) and the podium places revealed in the final.
   * Not saved: after a restart the screen is English again and the podium starts from 3rd.
   */
  screen: {
    lang: Lang;
    podiumShown: number;
    past?: PastOnScreen;
    ranking?: boolean;
    /** The overall ranking (all rounds added up) is shown (Phase 6.10). */
    overall?: boolean;
    /** The couple's review after the full ranking: the slide shown (Phase 9.5). */
    couple?: number;
  };
  /** Goes up with every warm-up start/end and restart (part of the host's step key). */
  round: number;
  guests: GuestBook;
  sessions: SessionStore;
  /** New guests may pick a name (the host's switch; saved). */
  joiningOpen: boolean;
  /** Collect mode (wristbands) is shelved for now: phones can't claim bands while false. */
  collectMode: boolean;
  /** The countdown of every question, in seconds (saved in questions.json). */
  timeLimitSec: number;
  /** Reveal the answer by itself (time up / everyone answered). The host's switch; saved. */
  autoReveal: boolean;
  /** Reading time before the answers (Phase 9.5). The host's switch; saved. */
  readingStep: boolean;
  /** Who the quiz is about (content/event.json): the lobby title and the sides' names. */
  event: EventInfo;
  /** Demo players' answer delay, in ms (from, to). */
  botAnswerMs: [number, number];
  /** Ends the process (Docker starts it again): switching between the demo and the event. */
  restart: () => void;
  /** Problems shown on the host panel. */
  warnings: string[];
  /** Setup notes (e.g. example files in use): in the server log and collapsed on the host panel. */
  notes: string[];
  /** Finished games (data/games, Phase 6.8). */
  archive: GameArchive;
  /** The question editor's writer for content/questions.json. */
  questionWriter: QuestionWriter;
  snapshots: SnapshotWriter;
  now: () => number;
  log: FastifyBaseLogger;
}

export interface AppServer {
  app: FastifyInstance;
  ctx: AppContext;
  realtime: Realtime;
}

export interface ServerOptions {
  /** Where the built client is. Served only if it exists. */
  clientDist?: string;
  /** false = silent (tests); a stream = log there (tests that read the log). Default: stdout. */
  logger?: boolean | { stream: NodeJS.WritableStream };
  now?: () => number;
  /** Collect mode (a possible later feature; Damian, Phase 9): off unless a test turns it on. */
  collectMode?: boolean;
  /** Demo players answer after this many ms (tests make it short). */
  botAnswerMs?: [number, number];
  /** Ends the process so Docker starts it again (the demo ↔ event switch). */
  restart?: () => void;
}

/** Throws on bad content (questions, guest list): call at startup only. */
export async function createServer(
  config: Config,
  options: ServerOptions = {},
): Promise<AppServer> {
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            ...(typeof options.logger === 'object' ? { stream: options.logger.stream } : {}),
            serializers: {
              req: (req: { method: string; url: string; ip?: string }) => ({
                method: req.method,
                url: req.url,
                remoteAddress: req.ip,
              }),
            },
          },
    trustProxy: config.trustProxy,
    bodyLimit: 16 * 1024,
  });

  const questions = loadQuestions(config.contentDir);
  const guestList = loadGuests(config.contentDir);
  const event = loadEvent(config.contentDir);
  const lists: QuestionLists = {
    questions: questions.items,
    warmup: questions.warmup ?? [],
    sets: questions.sets,
    ...(questions.couple ? { couple: true } : {}),
  };
  const game = loadGame(
    config.dataDir,
    (list) => listOf(lists, list),
    guestList.items,
    now(),
    guestList.isExample,
    questions.timeLimitSec,
  );
  const warnings = [...questions.warnings, ...guestList.warnings, game.warning].filter(
    (w): w is string => !!w,
  );
  const notes = [...questions.notes, ...guestList.notes, ...event.notes, ...game.notes];
  for (const w of warnings) app.log.warn(w);
  for (const n of notes) app.log.info(n);

  const ctx: AppContext = {
    config,
    quiz: game.quiz,
    collect: game.collect,
    warmup: { quiz: null },
    lists,
    activeSet: game.activeSet,
    rounds: game.rounds,
    screen: { lang: 'en', podiumShown: 0 },
    round: 0,
    archive: new GameArchive(join(config.dataDir, 'games')),
    guests: game.guests,
    sessions: game.sessions,
    // the public demo starts open: a visitor's phone should join at once, not wait
    joiningOpen: game.joiningOpen || config.demo === true,
    collectMode: options.collectMode ?? false,
    timeLimitSec: questions.timeLimitSec,
    autoReveal: game.autoReveal,
    readingStep: game.readingStep,
    event: event.event,
    botAnswerMs: options.botAnswerMs ?? BOT_ANSWER_MS,
    restart:
      options.restart ?? (() => app.log.warn('restart requested (no restart in this setup)')),
    warnings,
    notes,
    questionWriter: new QuestionWriter(
      config.contentDir,
      (e) => {
        app.log.error(e, 'saving questions.json failed');
        if (!ctx.warnings.includes(QUESTIONS_SAVE_FAILED)) ctx.warnings.push(QUESTIONS_SAVE_FAILED);
        realtime.broadcast(); // (only ever called after the server has started)
      },
      () => {
        // a later save worked: the file has everything again
        if (!ctx.warnings.includes(QUESTIONS_SAVE_FAILED)) return;
        ctx.warnings = ctx.warnings.filter((w) => w !== QUESTIONS_SAVE_FAILED);
        realtime.broadcast();
      },
    ),
    now,
    log: app.log,
    snapshots: new SnapshotWriter(
      config.dataDir,
      () => ({
        version: SNAPSHOT_VERSION,
        savedAt: now(),
        quiz: ctx.quiz.state,
        collect: ctx.collect.state,
        sessions: ctx.sessions.sessions,
        addedGuests: ctx.guests.added,
        joiningOpen: ctx.joiningOpen,
        autoReveal: ctx.autoReveal,
        readingStep: ctx.readingStep,
        activeSet: ctx.activeSet,
        rounds: ctx.rounds,
      }),
      (e) => app.log.error(e, 'saving the snapshot failed'),
      game.mainIsGood,
    ),
  };
  // Save at once, so a rejected snapshot's replacement is on disk.
  ctx.snapshots.saveNow();

  app.get('/health', () => ({ ok: true }));
  registerHttp(app, ctx);

  // Quiz photos (content/photos, git-ignored). The gate lets only admins and guests with a
  // session through; only plain image file names are served (like validateQuestions allows).
  const photos = resolve(config.contentDir, 'photos');
  try {
    mkdirSync(photos, { recursive: true }); // the question editor uploads into it
  } catch (e) {
    app.log.warn(e, 'content/photos could not be created (read-only content folder?)');
  }
  if (existsSync(photos)) {
    await app.register(fastifyStatic, {
      root: photos,
      prefix: '/photos/',
      decorateReply: false,
      index: false,
      list: false,
      dotfiles: 'deny',
      // phones preload them in the waiting room, hours before the quiz; private: not for proxies
      cacheControl: false,
      setHeaders: (reply) => {
        reply.header('Cache-Control', 'private, max-age=43200');
      },
      allowedPath: (path) => PHOTO_NAME.test(path.replace(/^\//, '')),
    });
  }

  // In production the server also serves the built client (apps/client/dist).
  const clientDist = options.clientDist;
  if (clientDist && existsSync(clientDist)) {
    const root = resolve(clientDist);
    await app.register(fastifyStatic, {
      root,
      // fewer round trips on weak roaming data: file names under /assets/ change with every
      // build, so they can be kept for good; logos and fonts rarely change; the page itself
      // is always checked, so a redeploy is picked up at once
      cacheControl: false,
      setHeaders: (reply, path) => {
        // the folder inside dist, never the folders above it (e.g. a server path /srv/assets/…)
        const top = relative(root, path).replace(/\\/g, '/').split('/')[0];
        reply.header(
          'Cache-Control',
          top === 'assets'
            ? 'public, max-age=31536000, immutable'
            : top === 'fonts' || top === 'brand'
              ? 'public, max-age=86400'
              : 'no-cache',
        );
      },
    });
    // Page routes (/screen, /play, /host) load index.html. Missing files (e.g. an old
    // /assets/*.js after a redeploy) get a real 404 instead of HTML.
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      const isPage =
        (request.method === 'GET' || request.method === 'HEAD') &&
        !path.startsWith('/socket.io') &&
        !path.startsWith('/assets/') &&
        extname(path) === '';
      return isPage ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found' });
    });
  } else {
    // our own 404 also without a built client: Fastify's default one logs the raw URL
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }));
  }

  const realtime = attachRealtime(app.server, ctx);

  // Open websockets keep the HTTP server alive, so drop them before Fastify closes the server.
  // Close the transports (not disconnectSockets, which tells phones "don't reconnect"):
  // phones see a lost connection and reconnect by themselves once the server is back.
  app.addHook('preClose', (done) => {
    realtime.close();
    realtime.io.engine.close();
    done();
  });
  // The last word on disk before exiting.
  app.addHook('onClose', async () => {
    ctx.snapshots.saveNow();
    await ctx.snapshots.flush();
  });

  return { app, ctx, realtime };
}
