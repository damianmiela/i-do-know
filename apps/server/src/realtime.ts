// Socket.IO: who may connect, what each view receives, and the actions clients can send.
import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { Server, type Socket } from 'socket.io';
import {
  ANSWER_GRACE_MS,
  isTimerSec,
  LANGS,
  MAIN_SET,
  WARMUP_LIST,
  PODIUM_STEPS,
  TOO_MANY_CONNECTIONS,
  UNAUTHORIZED,
  type Ack,
  type ClientToServerEvents,
  type QuestionList,
  type ServerToClientEvents,
  type View,
} from '@idoknow/shared';
import { ipBucket, RateLimiter } from './auth';
import { normalizeCode } from './game/collect';
import {
  ANSWER_COUNT_THROTTLE_MS,
  CLAIM_PER_IP_PER_MINUTE,
  SEARCH_PER_IP_PER_MINUTE,
  SEARCH_RATE_MAX,
  SEARCH_RATE_WINDOW_MS,
  RELEASE_RECENT_MAX_MINUTES,
  SOCKET_MAX_MESSAGE_BYTES,
  SOCKETS_PER_IP_MAX,
  ALL_ANSWERED_BEAT_MS,
  BOT_PEOPLE,
  BOT_RIGHT_SHARE,
  SOCKETS_PER_SESSION_MAX,
} from './game/config';
import { isSafeKey, own } from './game/safe';
import { incomplete, PHOTO_NAME, Quiz, type Result } from './game/quiz';
import {
  applyEdit,
  coupleIn,
  createSet,
  deleteSet,
  listName,
  listOf,
  renameSet,
  setCouple,
  type Edit,
  type QuestionLists,
} from './questionStore';
import { gameRecord, isGameId, pastOnScreen } from './archive';
import { setEventFlag } from './demo';
import { clientIp, isSameOrigin } from './http';
import { identify } from './sessions';
import type { AppContext } from './server';
import {
  coupleSlide,
  guestView,
  hostGuestRows,
  hostQuestions,
  hostView,
  nextPodiumStep,
  pauseStepOf,
  overallRows,
  rankingRows,
  type RankingRow,
  stepOf,
  ranksOf,
  screenView,
  type Ranks,
  type ScreenExtras,
} from './views';

interface SocketData {
  view: View;
  /** Guest session id (play view only). */
  sid?: string;
  /** Client IP bucket, for the per-IP limits (play view only). */
  ip?: string;
}

type IoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type IoSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

const ok: Ack = { ok: true };
const GUESTS = 'guests';
const sessionRoom = (sid: string) => `s:${sid}`;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (error: Extract<Ack, { ok: false }>['error']): Ack => ({ ok: false, error });
/** Longest search text accepted. */
const QUERY_MAX_LENGTH = 50;

/** A full ranking to show: a round's, or the overall one over `overallRounds` rounds. */
interface Ranking {
  rows: RankingRow[];
  overallRounds?: number;
}

export interface Realtime {
  io: IoServer;
  /** Sends every connected client its current view. Call after any change to the game. */
  broadcast(): void;
  /** Stops timers (on shutdown). */
  close(): void;
}

export function attachRealtime(server: HttpServer, ctx: AppContext): Realtime {
  const io: IoServer = new Server(server, {
    serveClient: false,
    maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,
    // refuse other sites' pages (cross-site WebSocket hijacking with the guest's cookies)
    allowRequest: (req, callback) =>
      callback(null, isSameOrigin(req.headers.origin, req.headers.host)),
  });

  // Open phone sockets per session and per IP bucket (see SOCKETS_PER_SESSION_MAX).
  const openPerKey = new Map<string, number>();
  const bump = (key: string, by: number) => {
    const n = (openPerKey.get(key) ?? 0) + by;
    if (n > 0) openPerKey.set(key, n);
    else openPerKey.delete(key);
  };

  // Every socket needs a valid login (screen, host) or guest session (play).
  io.use((socket, next) => {
    const view: unknown = (socket.handshake.auth as Record<string, unknown>).view;
    const id = identify(socket.request.headers.cookie, ctx.config, ctx.now());
    if (view === 'play' && id.sid) {
      const ip = ipBucket(clientIp(socket.request, ctx.config.trustProxy));
      const sidKey = `s:${id.sid}`;
      const ipKey = `i:${ip}`;
      if (
        (openPerKey.get(sidKey) ?? 0) >= SOCKETS_PER_SESSION_MAX ||
        (openPerKey.get(ipKey) ?? 0) >= SOCKETS_PER_IP_MAX
      ) {
        return next(new Error(TOO_MANY_CONNECTIONS));
      }
      bump(sidKey, 1);
      bump(ipKey, 1);
      socket.once('disconnect', () => {
        bump(sidKey, -1);
        bump(ipKey, -1);
      });
      socket.data = { view, sid: id.sid, ip };
    } else if ((view === 'screen' || view === 'host') && id.admin) socket.data = { view };
    else return next(new Error(UNAUTHORIZED));
    next();
  });

  const guestIdOf = (sid: string | undefined) => (sid ? ctx.sessions.guestOf(sid) : null);
  /**
   * A name that went free before the real quiz started leaves the player list too (else the
   * screen's "N joined" and the Top 10 would count people who aren't playing).
   */
  function dropPlayerIfFree(guestId: string): void {
    if (ctx.quiz.state.phase !== 'lobby' || ctx.sessions.isTaken(guestId)) return;
    ctx.quiz.removePlayer(guestId);
    ctx.warmup.quiz?.removePlayer(guestId);
  }

  /** Warnings that follow the questions as they are edited. */
  function contentWarnings(): string[] {
    const out: string[] = [];
    const missing = incomplete(ctx.quiz.questions).length;
    if (missing) {
      out.push(
        `${missing} ${missing === 1 ? 'question misses' : 'questions miss'} translations: the quiz can't start until every language is filled in.`,
      );
    }
    const practice = incomplete(ctx.lists.warmup).length;
    if (practice)
      out.push(`${practice} warm-up question(s) miss translations: the warm-up can't start.`);
    return out;
  }

  /** A photo question's picture must be in content/photos (uploaded first). */
  function photoExists(question: unknown): boolean {
    const photo = (question as { kind?: unknown; photo?: unknown } | null)?.photo;
    if ((question as { kind?: unknown } | null)?.kind !== 'photo' || typeof photo !== 'string') {
      return true; // nothing to check here (questionProblems() reports a missing photo)
    }
    return PHOTO_NAME.test(photo) && existsSync(join(ctx.config.contentDir, 'photos', photo));
  }

  /** The quiz being played: the warm-up round while one runs, the real quiz otherwise. */
  const active = () => ctx.warmup.quiz ?? ctx.quiz;
  /**
   * The podium places shown, plus one once the full ranking is out, plus one per slide of the
   * couple's review, which comes after it (part of the step key).
   */
  const podiumKey = () =>
    ctx.screen.podiumShown +
    (ctx.screen.ranking ? 1 : 0) +
    (ctx.screen.couple !== undefined ? ctx.screen.couple + 1 : 0);

  /**
   * The couple plays along in the round being played (Phase 9.5): the bride and groom marked in
   * guests.json answer like everyone, but stay out of every ranking. Set on the real quiz after
   * every change of lists, set or quiz.
   */
  function syncCouple(): void {
    const { bride, groom } = ctx.guests.couple();
    const on = coupleIn(ctx.lists, ctx.activeSet);
    ctx.quiz.offBoard = new Set(on ? [bride?.id, groom?.id].filter((id) => id !== undefined) : []);
  }
  syncCouple();
  /** The couple's review slide on screen now (not during the warm-up or the overall ranking). */
  const coupleNow = () =>
    !ctx.warmup.quiz &&
    ctx.quiz.state.phase === 'final' &&
    ctx.screen.couple !== undefined &&
    !ctx.screen.overall
      ? coupleSlide(ctx.quiz, ctx.guests.couple(), ctx.screen.couple)
      : undefined;
  /** Where the game is (see stepOf): step actions and the auto-reveal check it. */
  const stepKey = () => stepOf(active(), podiumKey(), ctx.round);

  /** Host only: every question list with the answers. */
  const questionLists = () => ({
    questions: hostQuestions(ctx.lists.questions, ctx.timeLimitSec),
    warmup: hostQuestions(ctx.lists.warmup, ctx.timeLimitSec),
    sets: ctx.lists.sets.map((s) => ({
      id: s.id,
      name: s.name,
      questions: hostQuestions(s.questions, ctx.timeLimitSec),
      ...(s.couple ? { couple: true } : {}),
    })),
    ...(ctx.lists.couple ? { couple: true } : {}),
  });

  function onlineSids(): Set<string> {
    const sids = new Set<string>();
    for (const s of io.of('/').sockets.values()) if (s.data.sid) sids.add(s.data.sid);
    return sids;
  }

  const countryOf = (id: string) => ctx.guests.get(id)?.country;
  /**
   * Everyone's place: the overall ranking (all rounds added up, Phase 6.10) while the host shows
   * it in the waiting room or after a round, else the round's full ranking after its podium.
   */
  function currentRanking(): Ranking | undefined {
    if (ctx.warmup.quiz) return undefined;
    const phase = ctx.quiz.state.phase;
    const overallPhase =
      phase === 'lobby' || (phase === 'final' && ctx.screen.podiumShown >= PODIUM_STEPS);
    if (ctx.screen.overall && ctx.rounds.length && overallPhase) {
      return { rows: overallRows(ctx.rounds, countryOf), overallRounds: ctx.rounds.length };
    }
    if (ctx.screen.ranking && phase === 'final') return { rows: rankingRows(ctx.quiz, countryOf) };
    return undefined;
  }

  const screenExtras = (ranking = currentRanking()): ScreenExtras => ({
    event: ctx.event,
    lang: ctx.screen.lang,
    joiningOpen: ctx.joiningOpen,
    podiumShown: ctx.screen.podiumShown,
    podiumKey: podiumKey(),
    countryOf,
    ...(ctx.screen.past ? { past: ctx.screen.past } : {}),
    ...(ranking ? { ranking: ranking.rows } : {}),
    ...(ranking?.overallRounds ? { overallRounds: ranking.overallRounds } : {}),
    ...(ctx.activeSet !== MAIN_SET ? { roundName: listName(ctx.lists, ctx.activeSet) } : {}),
    ...(coupleNow() ? { couple: coupleNow() } : {}),
  });
  const hostExtras = () => ({
    ...screenExtras(),
    demo: ctx.config.demo === true,
    eventMode: ctx.config.event === true,
    // guests with a name and an open connection (devices still picking a name don't count)
    connectedGuests: new Set(
      [...onlineSids()].map((sid) => ctx.sessions.guestOf(sid)).filter((id) => id !== null),
    ).size,
    joinedGuests: new Set(Object.values(ctx.sessions.sessions).map((s) => s.guestId)).size,
    guestCount: Object.keys(ctx.guests.all).length,
    lastSavedAt: ctx.snapshots.lastSavedAt,
    round: ctx.round,
    saveFailing: ctx.snapshots.failing,
    warnings: [...ctx.warnings, ...contentWarnings()],
    notes: ctx.notes,
    timeLimitSec: ctx.timeLimitSec,
    autoReveal: ctx.autoReveal,
    readingStep: ctx.readingStep,
    activeSet: ctx.activeSet,
    playedSets: [...new Set(ctx.rounds.map((r) => r.setId))],
    roundsPlayed: ctx.rounds.length,
    overallShown: !!ctx.screen.overall,
    warmupAvailable: ctx.lists.warmup.length > 0,
    coupleMarked: {
      ...(ctx.guests.couple().bride ? { bride: ctx.guests.couple().bride!.name } : {}),
      ...(ctx.guests.couple().groom ? { groom: ctx.guests.couple().groom!.name } : {}),
    },
    coupleRound: ctx.quiz.offBoard.size > 0,
  });

  function sendView(socket: IoSocket, ranks: Ranks, now: number, ranking = currentRanking()): void {
    const { view, sid } = socket.data;
    if (view === 'play') socket.emit('state:guest', myView(sid, ranks, now, ranking));
    else if (view === 'screen')
      socket.emit('state:screen', screenView(active(), now, screenExtras()));
    else socket.emit('state:host', hostView(active(), now, hostExtras()));
  }

  function myView(sid: string | undefined, ranks: Ranks, now: number, ranking = currentRanking()) {
    const guestId = guestIdOf(sid);
    const band = guestId ? ctx.collect.bandOf(guestId) : undefined;
    return guestView(active(), guestId, ranks, now, {
      band,
      podiumShown: ctx.screen.podiumShown,
      joiningOpen: ctx.joiningOpen,
      roundsPlayed: ctx.rounds.length,
      ...(ranking ? { ranking: ranking.rows } : {}),
      ...(ranking?.overallRounds ? { overallRounds: ranking.overallRounds } : {}),
      ...(coupleNow() ? { couple: coupleNow() } : {}),
    });
  }

  /** Sends one device (all its tabs) its current view. */
  function sendToSession(sid: string): void {
    io.to(sessionRoom(sid)).emit('state:guest', myView(sid, ranksOf(active()), ctx.now()));
  }

  /** The host's guest list. Sent on changes, never on every answer. */
  function sendGuests(): void {
    io.to('host').emit(
      'state:guests',
      hostGuestRows(ctx.guests, ctx.sessions, ctx.collect, onlineSids()),
    );
  }

  function broadcast(): void {
    const now = ctx.now();
    const ranks = ranksOf(active());
    const ranking = currentRanking(); // once for everyone
    io.to('screen').emit('state:screen', screenView(active(), now, screenExtras(ranking)));
    io.to('host').emit('state:host', hostView(active(), now, hostExtras()));
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.view === 'play') sendView(socket, ranks, now, ranking);
    }
    armAutoReveal(); // every change of the game passes here
    botsPlay();
  }

  // Demo players (DEMO_MODE only): they answer each question by themselves, after a random
  // delay once the answers are shown, mostly right. They are ordinary host-added guests (the host
  // can remove them); only the answering happens here, through the same game call as a phone.
  const bots = new Set<string>();
  const botTimers = new Set<NodeJS.Timeout>();
  let botQuestion = '';
  function botsPlay(): void {
    const quiz = active();
    const s = quiz.state;
    const q = quiz.question;
    if (closed || bots.size === 0 || s.phase !== 'question' || s.reading || !q) return;
    const key = `${ctx.round}:${quiz.warmup ? 'w' : 'q'}:${q.id}:${s.startedAt}`;
    if (key === botQuestion) return; // already on their way for this question
    botQuestion = key;
    const [from, to] = ctx.botAnswerMs;
    for (const id of bots) {
      const timer = setTimeout(
        () => {
          botTimers.delete(timer);
          if (botQuestion !== key || active() !== quiz || quiz.state.phase !== 'question') return;
          const right = Math.random() < BOT_RIGHT_SHARE;
          const others = q.options.map((_, i) => i).filter((i) => i !== q.correct);
          const option = right ? q.correct : others[Math.floor(Math.random() * others.length)]!;
          if (!quiz.answer(id, option, ctx.now()).ok) return; // removed, paused, too late
          ctx.snapshots.saveSoon();
          countsSoon();
          answeredSoon();
          armAutoReveal();
        },
        from + Math.random() * (to - from),
      );
      botTimers.add(timer);
    }
  }

  // Auto-reveal (Phase 6.9): on the server, so it works while the host panel is closed or
  // reconnecting. When the time (plus the grace for late taps) is up, or every active player has
  // answered (then a short beat later, so the last one sees their ✓), the answer is revealed.
  // The Top 10 and the next question still wait for the host. Pause stops it, "+10 s" moves it.
  let revealTimer: NodeJS.Timeout | undefined;
  function armAutoReveal(): void {
    clearTimeout(revealTimer);
    revealTimer = undefined;
    const quiz = active();
    const s = quiz.state;
    if (closed || !ctx.autoReveal || s.phase !== 'question' || s.pausedAt !== null) return;
    const now = ctx.now();
    const timeUp = quiz.timeLeftMs(now) + ANSWER_GRACE_MS;
    const delay = quiz.everyoneAnswered() ? Math.min(ALL_ANSWERED_BEAT_MS, timeUp) : timeUp;
    const at = stepKey();
    revealTimer = setTimeout(
      () => {
        revealTimer = undefined;
        // only the question it was set for (the host may have revealed, skipped or paused)
        if (stepKey() !== at || active().state.pausedAt !== null || !ctx.autoReveal) return;
        if (!active().next(ctx.now()).ok) return;
        ctx.log.info('answer revealed automatically');
        ctx.snapshots.saveNow();
        broadcast();
      },
      Math.max(delay, 0),
    );
  }

  // Answer counts and connected guests change often: update screen and host at most every 250 ms.
  let countsTimer: NodeJS.Timeout | undefined;
  let closed = false;
  function countsSoon(): void {
    if (closed) return; // sockets disconnecting during shutdown
    countsTimer ??= setTimeout(() => {
      countsTimer = undefined;
      const now = ctx.now();
      io.to('screen').emit('state:screen', screenView(active(), now, screenExtras()));
      io.to('host').emit('state:host', hostView(active(), now, hostExtras()));
    }, ANSWER_COUNT_THROTTLE_MS);
  }

  // after every save (or failed save) the host's "saved N s ago" and warning are fresh at once
  ctx.snapshots.onWritten = countsSoon;

  // Phones see how many have answered: a tiny message, at most once a second.
  let answeredTimer: NodeJS.Timeout | undefined;
  function answeredSoon(): void {
    if (closed) return;
    answeredTimer ??= setTimeout(() => {
      answeredTimer = undefined;
      const s = active().state;
      if (s.phase !== 'question') return;
      io.to(GUESTS).emit('state:answered', {
        answeredCount: Object.keys(s.answers).length,
        playerCount: Object.keys(s.players).length,
      });
    }, 1_000);
  }

  // Guests going online/offline change the host's list: at most once a second.
  let guestsTimer: NodeJS.Timeout | undefined;
  function guestsSoon(): void {
    if (closed) return;
    guestsTimer ??= setTimeout(() => {
      guestsTimer = undefined;
      sendGuests();
    }, 1_000);
  }

  // Limits for the name search and claims: per device (session) and per IP, so reconnecting or
  // opening more sockets doesn't reset them. Minting new sessions only helps within the IP budget.
  const searchPerSession = new RateLimiter(SEARCH_RATE_MAX, SEARCH_RATE_WINDOW_MS);
  const searchPerIp = new RateLimiter(SEARCH_PER_IP_PER_MINUTE, 60_000);
  const claimPerIp = new RateLimiter(CLAIM_PER_IP_PER_MINUTE, 60_000);

  // A per-IP limit is only reached by a script (or an unusual crowd): tell the host, at most
  // every 10 minutes per kind. The IP goes to the log only.
  const lastLimitWarning = { search: 0, claim: 0 };
  function limitHit(kind: 'search' | 'claim', ip: string, now: number): Ack {
    if (now - lastLimitWarning[kind] > 10 * 60_000) {
      lastLimitWarning[kind] = now;
      ctx.log.warn({ ip }, `per-IP ${kind} limit reached`);
      const time = new Date(now).toISOString().slice(11, 16);
      ctx.warnings.push(
        `${time} UTC: unusually many name ${kind === 'search' ? 'searches' : 'claims'} from one network. If someone is taking names, close joining for a while and release the wrong names.`,
      );
      if (ctx.warnings.length > 20) ctx.warnings.splice(0, ctx.warnings.length - 20);
      io.to('host').emit('state:host', hostView(active(), now, hostExtras()));
    }
    return fail('rate-limited');
  }

  // A claim changes everyone's player count: send it at most every half second, not per claim.
  let everyoneTimer: NodeJS.Timeout | undefined;
  function broadcastSoon(): void {
    if (closed) return;
    everyoneTimer ??= setTimeout(() => {
      everyoneTimer = undefined;
      broadcast();
    }, 500);
  }

  /**
   * Registers a client action. Only sockets of `view` may use it; input is checked by `run`,
   * which returns the ack. Never throws, and always replies (if the client asked for a reply).
   */
  function action(
    socket: IoSocket,
    event: keyof ClientToServerEvents,
    view: View,
    run: (payload: unknown) => Ack,
  ): void {
    socket.on(event, (...args: unknown[]) => {
      const last = args.at(-1);
      const reply = typeof last === 'function' ? (last as (r: Ack) => void) : undefined;
      const payload = reply && args.length === 1 ? undefined : args[0];
      let result: Ack;
      try {
        result = socket.data.view === view ? run(payload) : { ok: false, error: 'forbidden' };
      } catch (e) {
        ctx.log.error(e, `socket action ${event} failed`);
        result = { ok: false, error: 'server-error' };
      }
      reply?.(result);
    });
  }

  /** A host action changes the game: save it and show everyone the new state. */
  const hostAction = (result: Result | Ack): Ack => {
    if (result.ok) {
      ctx.snapshots.saveNow();
      broadcast();
    }
    return result;
  };

  io.on('connection', (socket) => {
    const { view, sid } = socket.data;
    void socket.join(sid ? [GUESTS, sessionRoom(sid)] : view);
    // A (re)connect always gets the full current state: that's the whole reconnection story.
    sendView(socket, ranksOf(active()), ctx.now());
    if (view === 'host') {
      socket.emit(
        'state:guests',
        hostGuestRows(ctx.guests, ctx.sessions, ctx.collect, onlineSids()),
      );
      // the questions with their answers: host only (sent again after every edit)
      socket.emit('state:questions', questionLists());
    }
    if (sid) {
      countsSoon();
      guestsSoon();
      socket.on('disconnect', () => {
        countsSoon();
        guestsSoon();
      });
    }

    action(socket, 'guest:search', 'play', (payload) => {
      if (!isRecord(payload) || typeof payload.query !== 'string') return fail('invalid-input');
      if (payload.query.length > QUERY_MAX_LENGTH) return fail('invalid-input');
      // only for picking a name: a device that has one never reads the list again
      if (guestIdOf(sid)) return fail('already-joined');
      if (!ctx.joiningOpen) return fail('joining-closed');
      const now = ctx.now();
      if (searchPerSession.blocked(sid!, now)) return fail('rate-limited');
      if (searchPerIp.blocked(socket.data.ip!, now))
        return limitHit('search', socket.data.ip!, now);
      searchPerSession.record(sid!, now);
      searchPerIp.record(socket.data.ip!, now);
      const results = ctx.guests.search(payload.query, (id) => ctx.sessions.isTaken(id));
      return results ? { ok: true, results } : fail('query-too-short');
    });

    // "This is me": the name is locked to this device until the host releases it.
    action(socket, 'guest:claim', 'play', (payload) => {
      if (!isRecord(payload) || !isSafeKey(payload.guestId)) return fail('invalid-input');
      const guestId = payload.guestId;
      const mine = guestIdOf(sid);
      if (mine === guestId) return ok; // tapped twice, or a second tab
      if (mine) return fail('already-joined');
      if (!ctx.joiningOpen) return fail('joining-closed');
      const guest = ctx.guests.get(guestId);
      if (!guest) return fail('unknown-guest');
      if (ctx.sessions.isTaken(guestId)) return fail('name-taken');
      if (!claimPerIp.take(socket.data.ip!, ctx.now())) {
        return limitHit('claim', socket.data.ip!, ctx.now());
      }
      ctx.sessions.bind(sid!, guestId, ctx.now());
      ctx.quiz.addPlayer(guestId, guest.name); // no-op if they played before (score kept)
      ctx.warmup.quiz?.addPlayer(guestId, guest.name);
      const player = own(ctx.quiz.state.players, guestId);
      if (player) player.name = guest.name; // the list may have corrected the spelling
      ctx.log.info({ guestId }, 'name claimed');
      ctx.snapshots.saveNow();
      sendToSession(sid!); // this device at once, everyone else's player count a bit later
      broadcastSoon();
      guestsSoon();
      return ok;
    });

    // "Not you? Change name": only your own name, and only before the real quiz starts
    action(socket, 'guest:unclaim', 'play', () => {
      const guestId = guestIdOf(sid);
      if (!guestId) return fail('not-joined');
      if (ctx.quiz.state.phase !== 'lobby') return fail('wrong-phase');
      // with joining closed the device could never pick a name again: only the host helps here
      if (!ctx.joiningOpen) return fail('joining-closed');
      ctx.sessions.unbind(sid!);
      dropPlayerIfFree(guestId); // nobody else plays under this name
      ctx.log.info({ guestId }, 'name given back');
      ctx.snapshots.saveNow();
      sendToSession(sid!);
      broadcastSoon();
      guestsSoon();
      return ok;
    });

    action(socket, 'collect:claimBand', 'play', (payload) => {
      if (!ctx.collectMode) return fail('collect-off'); // shelved: a later possible feature
      if (!isRecord(payload) || typeof payload.code !== 'string') return fail('invalid-input');
      const guestId = guestIdOf(sid);
      if (!guestId) return fail('not-joined');
      const result = ctx.collect.claimBand(guestId, payload.code);
      if (!result.ok) return result;
      // claiming your own band again changes nothing: no save, no messages
      if (result.changed) {
        ctx.snapshots.saveNow();
        sendToSession(sid!);
        sendGuests();
      }
      return ok;
    });

    action(socket, 'quiz:answer', 'play', (payload) => {
      if (!isRecord(payload) || !Number.isInteger(payload.option)) {
        return { ok: false, error: 'invalid-input' };
      }
      const guestId = guestIdOf(sid);
      if (!guestId) return { ok: false, error: 'not-joined' };
      // a tap sent late (bad connection, host pressed skip) must never count for another question
      if (payload.questionId !== active().question?.id) return fail('wrong-question');
      const now = ctx.now();
      const result = active().answer(guestId, payload.option as number, now);
      if (result.ok) {
        ctx.snapshots.saveSoon();
        // all tabs of this guest see the locked answer
        io.to(sessionRoom(sid!)).emit('state:guest', myView(sid, ranksOf(active()), now));
        countsSoon();
        answeredSoon();
        armAutoReveal(); // everyone may have answered now
      }
      return result;
    });

    const host = (event: keyof ClientToServerEvents, run: (payload: unknown) => Result | Ack) =>
      action(socket, event, 'host', (payload) => hostAction(run(payload)));
    // steps: refused when the game has already moved on (double tap, a second host, a replay)
    const guarded =
      (key: () => string) => (event: keyof ClientToServerEvents, run: () => Result | Ack) =>
        host(event, (payload) =>
          isRecord(payload) && payload.at === key()
            ? run()
            : fail(isRecord(payload) && typeof payload.at === 'string' ? 'stale' : 'invalid-input'),
        );
    const step = guarded(stepKey);
    const pauseStep = guarded(() => pauseStepOf(active(), podiumKey(), ctx.round));
    /**
     * The real quiz just reached its final: save it to the archive (Phase 6.8). Once per game: a
     * restart at the final doesn't pass this step again. A failed write never stops the game.
     */
    function archiveIfFinished(result: Result): Result {
      if (!result.ok || ctx.warmup.quiz || ctx.quiz.state.phase !== 'final') return result;
      const setName = listName(ctx.lists, ctx.activeSet);
      // the round's scores, for the overall ranking (saved with the snapshot)
      ctx.rounds.push({
        setId: ctx.activeSet,
        setName,
        finishedAt: ctx.now(),
        players: Object.fromEntries(
          Object.values(ctx.quiz.state.players)
            .filter((p) => !ctx.quiz.offBoard.has(p.id)) // the couple: never in a ranking
            .map((p) => [p.id, { name: p.name, score: p.score, correctCount: p.correctCount }]),
        ),
      });
      try {
        const record = gameRecord(
          ctx.quiz,
          countryOf,
          ctx.timeLimitSec,
          ctx.now(),
          (id) => ctx.guests.get(id)?.role,
        );
        const id = ctx.archive.save(ctx.activeSet === MAIN_SET ? record : { ...record, setName });
        ctx.log.info({ id }, 'game archived');
      } catch (e) {
        ctx.log.error(e, 'archiving the game failed');
        ctx.warnings.push(
          'Saving this game to the archive (data/games) failed: check the disk. The game itself goes on.',
        );
      }
      return result;
    }
    /** A new round starts: the big screen shows the live game again. */
    const live = <R>(result: R): R => {
      delete ctx.screen.past;
      ctx.screen.overall = false;
      return result;
    };

    step('host:start', () =>
      // guests must never see a missing translation: the real quiz starts only when complete
      !ctx.warmup.quiz && incomplete(ctx.quiz.questions).length
        ? fail('translations-missing')
        : live(active().start(ctx.now(), ctx.readingStep)),
    );
    step('host:next', () => archiveIfFinished(active().next(ctx.now(), ctx.readingStep)));
    step('host:skip', () => archiveIfFinished(active().skip(ctx.now(), ctx.readingStep)));
    // reading time over (Phase 9.5): the answers appear everywhere and the countdown starts
    step('host:showAnswers', () => active().showAnswers(ctx.now()));
    pauseStep('host:pause', () => active().pause(ctx.now()));
    pauseStep('host:resume', () => active().resume(ctx.now()));
    host('host:addTime', (payload) =>
      isRecord(payload) && typeof payload.ms === 'number'
        ? active().addTime(payload.ms)
        : { ok: false, error: 'invalid-input' },
    );
    step('host:restart', () => {
      // during the warm-up: back to the real lobby (Start must never replay the practice round)
      if (ctx.warmup.quiz) {
        ctx.warmup.quiz = null;
        ctx.screen.podiumShown = 0;
      } else {
        ctx.quiz.restart();
        ctx.screen.podiumShown = 0;
        ctx.screen.ranking = false;
        delete ctx.screen.couple;
        // back in the waiting room: names released during the game leave the player list now
        for (const id of Object.keys(ctx.quiz.state.players)) dropPlayerIfFree(id);
      }
      ctx.round++;
      return live(ok);
    });
    // New guests may pick a name only while joining is open; everyone with a name stays in.
    host('host:setJoining', (payload) => {
      if (!isRecord(payload) || typeof payload.open !== 'boolean') return fail('invalid-input');
      ctx.joiningOpen = payload.open;
      ctx.log.info(`joining ${payload.open ? 'opened' : 'closed'}`);
      return ok;
    });

    // Warm-up round: a separate practice quiz for everyone who joined. It never touches the real
    // quiz or its scores, and it can be played again and again (it isn't saved in the snapshot).
    step('host:startWarmup', () => {
      if (!ctx.lists.warmup.length) return fail('no-warmup');
      if (incomplete(ctx.lists.warmup).length) return fail('translations-missing');
      if (ctx.warmup.quiz || ctx.quiz.state.phase !== 'lobby') return fail('wrong-phase');
      const warmup = new Quiz(ctx.lists.warmup, undefined, true, ctx.timeLimitSec);
      for (const p of Object.values(ctx.quiz.state.players)) warmup.addPlayer(p.id, p.name);
      warmup.start(ctx.now(), ctx.readingStep);
      ctx.warmup.quiz = warmup;
      ctx.round++;
      ctx.screen.podiumShown = 0;
      delete ctx.screen.past;
      ctx.screen.overall = false;
      ctx.log.info('warm-up started');
      return ok;
    });
    step('host:endWarmup', () => {
      if (!ctx.warmup.quiz) return fail('wrong-phase');
      ctx.warmup.quiz = null;
      ctx.screen.podiumShown = 0;
      ctx.round++;
      ctx.log.info('warm-up ended');
      return ok;
    });

    host('host:setReadingStep', (payload) => {
      if (!isRecord(payload) || typeof payload.on !== 'boolean') return fail('invalid-input');
      ctx.readingStep = payload.on; // from the next question on
      ctx.log.info(`reading time ${payload.on ? 'on' : 'off'}`);
      return ok;
    });

    host('host:setAutoReveal', (payload) => {
      if (!isRecord(payload) || typeof payload.on !== 'boolean') return fail('invalid-input');
      ctx.autoReveal = payload.on;
      ctx.log.info(`auto-reveal ${payload.on ? 'on' : 'off'}`);
      return ok; // saved and re-armed by hostAction → broadcast
    });

    // The big screen
    host('host:setScreenLang', (payload) => {
      if (!isRecord(payload) || !(LANGS as readonly unknown[]).includes(payload.lang)) {
        return fail('invalid-input');
      }
      ctx.screen.lang = payload.lang as (typeof LANGS)[number];
      return ok;
    });
    // 3rd, 2nd, 1st place, one tap each: the phones show the places only after the last one
    step('host:podiumNext', () => {
      // the warm-up plays its podium too (Phase 6.10)
      if (active().state.phase !== 'final') return fail('wrong-phase');
      if (ctx.screen.podiumShown >= PODIUM_STEPS) return fail('wrong-phase');
      ctx.screen.podiumShown = nextPodiumStep(active(), ctx.screen.podiumShown);
      return ok;
    });

    // The game archive (Phase 6.8): host only. The files hold everyone's names and answers.
    action(socket, 'host:games', 'host', () => ({ ok: true, games: ctx.archive.list() }));
    action(socket, 'host:game', 'host', (payload) => {
      if (!isRecord(payload) || !isGameId(payload.id)) return fail('invalid-input');
      const game = ctx.archive.get(payload.id);
      return game ? { ok: true, game } : fail('unknown-game');
    });
    action(socket, 'host:gameDelete', 'host', (payload) => {
      if (!isRecord(payload) || !isGameId(payload.id)) return fail('invalid-input');
      if (!ctx.archive.delete(payload.id)) return fail('unknown-game');
      ctx.log.info({ id: payload.id }, 'archived game deleted');
      if (ctx.screen.past?.id === payload.id) {
        delete ctx.screen.past;
        broadcast();
      }
      return ok;
    });
    // A past game on the big screen: never during a quiz or the warm-up (the room follows the
    // live game then). Not saved: after a restart the screen shows the live game.
    host('host:showPast', (payload) => {
      if (!isRecord(payload)) return fail('invalid-input');
      if (payload.id === null) return live(ok);
      if (!isGameId(payload.id)) return fail('invalid-input');
      const q = payload.question;
      if (q !== undefined && !(Number.isInteger(q) && (q as number) >= 0)) {
        return fail('invalid-input');
      }
      const phase = ctx.quiz.state.phase;
      if (ctx.warmup.quiz || (phase !== 'lobby' && phase !== 'final')) return fail('wrong-phase');
      // never over a podium that is still being revealed (audit 9)
      if (phase === 'final' && ctx.screen.podiumShown < PODIUM_STEPS) return fail('wrong-phase');
      const game = ctx.archive.get(payload.id);
      const past = game && pastOnScreen(game, q as number | undefined);
      if (!past) return fail('unknown-game');
      ctx.screen.past = past;
      return ok;
    });

    // After the podium: everyone's place on the big screen and on every phone (Phase 6.9).
    step('host:showRanking', () => {
      if (ctx.warmup.quiz || ctx.quiz.state.phase !== 'final') return fail('wrong-phase');
      if (ctx.screen.podiumShown < PODIUM_STEPS || ctx.screen.ranking) return fail('wrong-phase');
      ctx.screen.ranking = true;
      delete ctx.screen.past;
      return ok;
    });

    // The couple's review (Phase 9.5): after the full ranking, slide by slide, then the summary.
    step('host:coupleNext', () => {
      if (ctx.warmup.quiz || ctx.quiz.state.phase !== 'final' || !ctx.screen.ranking) {
        return fail('wrong-phase');
      }
      if (ctx.quiz.offBoard.size === 0) return fail('wrong-phase'); // not a couple round
      const total = ctx.quiz.state.log.filter((e) => !e.skipped).length;
      const at = ctx.screen.couple;
      if (at !== undefined && at >= total) return fail('wrong-phase'); // the summary is the end
      ctx.screen.couple = at === undefined ? 0 : at + 1;
      delete ctx.screen.past;
      ctx.screen.overall = false;
      return ok;
    });

    // Question editor and timer: only in the waiting room (nothing changes under the guests' feet).
    const editable = () => !ctx.warmup.quiz && ctx.quiz.state.phase === 'lobby';
    /**
     * The waiting room with the same players, now with changed lists, another set or a new timer.
     * `write`: the lists changed, so questions.json is written (not for picking a set).
     */
    function replaceQuiz(lists: QuestionLists, sec: number, write = true): boolean {
      let quiz: Quiz;
      try {
        const questions = listOf(lists, ctx.activeSet) ?? lists.questions;
        quiz = new Quiz(questions, structuredClone(ctx.quiz.state), false, sec);
      } catch {
        return false;
      }
      ctx.quiz = quiz;
      ctx.lists = lists;
      syncCouple(); // another set, or its "couple plays along" switch changed
      if (write || sec !== ctx.timeLimitSec) {
        ctx.timeLimitSec = sec;
        // the real file exists from the first save on: no "example questions in use" any more
        ctx.notes = ctx.notes.filter((n) => !n.startsWith('content/questions.json is missing'));
        void ctx.questionWriter.save(lists, sec);
      }
      io.to('host').emit('state:questions', questionLists());
      return true;
    }
    host('host:setTimer', (payload) => {
      if (!editable()) return fail('editing-locked');
      if (!isRecord(payload) || !isTimerSec(payload.sec)) return fail('invalid-input');
      if (!replaceQuiz(ctx.lists, payload.sec)) return fail('invalid-question');
      ctx.log.info({ sec: payload.sec }, 'timer set');
      return ok;
    });

    // Question sets (Phase 6.10): more rounds, each played on its own; waiting room only.
    host('host:setCreate', (payload) => {
      if (!editable()) return fail('editing-locked');
      if (!isRecord(payload)) return fail('invalid-input');
      const result = createSet(ctx.lists, payload.name);
      if (!result.ok) return fail(result.error);
      if (!replaceQuiz(result.lists, ctx.timeLimitSec)) return fail('invalid-question');
      ctx.log.info({ id: result.id }, 'question set created');
      return { ok: true, id: result.id };
    });
    host('host:setRename', (payload) => {
      if (!editable()) return fail('editing-locked');
      if (!isRecord(payload)) return fail('invalid-input');
      const result = renameSet(ctx.lists, payload.id, payload.name);
      if (!result.ok) return fail(result.error);
      if (!replaceQuiz(result.lists, ctx.timeLimitSec)) return fail('invalid-question');
      return ok;
    });
    host('host:setDelete', (payload) => {
      if (!editable()) return fail('editing-locked');
      if (!isRecord(payload)) return fail('invalid-input');
      const result = deleteSet(ctx.lists, payload.id);
      if (!result.ok) return fail(result.error);
      const before = ctx.activeSet;
      if (ctx.activeSet === result.id) ctx.activeSet = MAIN_SET; // its round can't be played now
      if (!replaceQuiz(result.lists, ctx.timeLimitSec)) {
        ctx.activeSet = before;
        return fail('invalid-question');
      }
      ctx.log.info({ id: result.id }, 'question set deleted');
      return ok;
    });
    // which list the next round plays (the players stay; scores start at 0 in the waiting room)
    host('host:selectSet', (payload) => {
      if (!editable()) return fail('editing-locked');
      if (!isRecord(payload) || typeof payload.id !== 'string') return fail('invalid-input');
      if (payload.id === WARMUP_LIST || !listOf(ctx.lists, payload.id)) return fail('unknown-set');
      const before = ctx.activeSet;
      ctx.activeSet = payload.id;
      if (!replaceQuiz(ctx.lists, ctx.timeLimitSec, false)) {
        ctx.activeSet = before;
        return fail('invalid-question');
      }
      // the waiting room now announces the new round, not the overall ranking
      ctx.screen.overall = false;
      // a host panel that still shows the old round can't start the new one by mistake
      if (before !== payload.id) ctx.round++;
      ctx.log.info({ set: payload.id }, 'question set picked');
      return ok;
    });

    // The overall ranking (all rounds added up): in the waiting room or after a round.
    host('host:setCouple', (payload) => {
      if (!editable()) return fail('editing-locked');
      if (!isRecord(payload) || typeof payload.on !== 'boolean') return fail('invalid-input');
      const result = setCouple(ctx.lists, payload.list, payload.on);
      if (!result.ok) return fail(result.error);
      if (!replaceQuiz(result.lists, ctx.timeLimitSec)) return fail('invalid-question');
      ctx.log.info({ list: result.id, on: payload.on }, 'couple plays along');
      return ok;
    });

    host('host:showOverall', (payload) => {
      if (!isRecord(payload) || typeof payload.on !== 'boolean') return fail('invalid-input');
      if (!payload.on) {
        ctx.screen.overall = false;
        return ok;
      }
      const phase = ctx.quiz.state.phase;
      if (ctx.warmup.quiz || (phase !== 'lobby' && phase !== 'final')) return fail('wrong-phase');
      if (!ctx.rounds.length) return fail('wrong-phase');
      // places are the podium's news: not before the whole podium is revealed
      if (phase === 'final' && ctx.screen.podiumShown < PODIUM_STEPS) return fail('wrong-phase');
      ctx.screen.overall = true;
      delete ctx.screen.past;
      return ok;
    });
    host('host:resetOverall', () => {
      ctx.rounds = [];
      ctx.screen.overall = false;
      ctx.log.info('overall ranking reset');
      return ok;
    });
    const editQuestions = (
      event: keyof ClientToServerEvents,
      build: (p: Record<string, unknown>) => Edit,
    ) =>
      host(event, (payload) => {
        if (!editable()) return fail('editing-locked');
        if (!isRecord(payload) || typeof payload.list !== 'string') return fail('invalid-input');
        if (!listOf(ctx.lists, payload.list)) return fail('unknown-set');
        const change = build(payload);
        if (change.type === 'save' && !photoExists(change.question)) return fail('unknown-photo');
        const result = applyEdit(ctx.lists, change);
        if (!result.ok) return fail(result.error);
        if (!replaceQuiz(result.lists, ctx.timeLimitSec)) return fail('invalid-question');
        ctx.log.info({ event, id: result.id }, 'questions edited');
        return { ok: true, id: result.id };
      });
    editQuestions('host:questionSave', (p) => ({
      type: 'save',
      list: p.list as QuestionList,
      question: p.question,
      index: p.index,
    }));
    editQuestions('host:questionDelete', (p) => ({
      type: 'delete',
      list: p.list as QuestionList,
      id: p.id,
    }));
    editQuestions('host:questionMove', (p) => ({
      type: 'move',
      list: p.list as QuestionList,
      id: p.id,
      to: p.to,
    }));

    // Guest-list actions change only the host's list and the affected phones.
    const guestAction = (event: keyof ClientToServerEvents, run: (payload: unknown) => Ack) =>
      action(socket, event, 'host', (payload) => {
        const result = run(payload);
        if (result.ok) {
          ctx.snapshots.saveNow();
          sendGuests();
          countsSoon(); // the host's "joined" count
        }
        return result;
      });

    guestAction('host:releaseGuest', (payload) => {
      if (!isRecord(payload) || !isSafeKey(payload.guestId)) return fail('invalid-input');
      if (!ctx.guests.get(payload.guestId)) return fail('unknown-guest');
      // those devices go back to the name search; the score stays with the name
      for (const released of ctx.sessions.release(payload.guestId)) sendToSession(released);
      dropPlayerIfFree(payload.guestId);
      broadcastSoon(); // the player count
      ctx.log.info({ guestId: payload.guestId }, 'name released');
      return ok;
    });

    // strangers took names (e.g. a photo of the QR code went around): the recent names go free
    guestAction('host:releaseRecent', (payload) => {
      if (!isRecord(payload) || !Number.isInteger(payload.minutes)) return fail('invalid-input');
      const minutes = payload.minutes as number;
      if (minutes < 1 || minutes > RELEASE_RECENT_MAX_MINUTES) return fail('invalid-input');
      const now = ctx.now();
      const since = now - minutes * 60_000;
      const guestIds = new Set(
        Object.values(ctx.sessions.sessions)
          // "<= now": after the clock stepped back, old names don't count as recent
          .filter((s) => s.boundAt >= since && s.boundAt <= now)
          .map((s) => s.guestId),
      );
      for (const guestId of guestIds) {
        for (const released of ctx.sessions.release(guestId)) sendToSession(released);
        dropPlayerIfFree(guestId);
      }
      broadcastSoon();
      ctx.log.info({ minutes, released: guestIds.size }, 'recent names released');
      return { ok: true, released: guestIds.size };
    });

    // A guest the host added by mistake (or twice): the name, the player and the score go, at any
    // time (Damian's choice). Guests from guests.json are edited in the file instead.
    guestAction('host:removeGuest', (payload) => {
      if (!isRecord(payload) || !isSafeKey(payload.guestId)) return fail('invalid-input');
      const guestId = payload.guestId;
      if (!ctx.guests.get(guestId)) return fail('unknown-guest');
      if (!ctx.guests.isAdded(guestId)) return fail('not-added');
      const devices = ctx.sessions.release(guestId);
      ctx.quiz.removePlayer(guestId);
      ctx.warmup.quiz?.removePlayer(guestId);
      ctx.collect.forget(guestId);
      // their points leave the overall ranking too (a later added guest may get the same id)
      for (const round of ctx.rounds) delete round.players[guestId];
      ctx.guests.remove(guestId);
      for (const sid of devices) sendToSession(sid); // back to the name search
      broadcastSoon(); // player counts, Top 10
      ctx.log.info({ guestId }, 'added guest removed');
      return ok;
    });

    // the real event (switched from the demo): back to the demo. The event's data stays saved.
    action(socket, 'host:endEvent', 'host', () => {
      if (!ctx.config.event || !ctx.config.eventDir) return fail('forbidden');
      setEventFlag(ctx.config.eventDir, false);
      ctx.snapshots.saveNow();
      ctx.log.warn('event ended: back to the demo');
      setTimeout(ctx.restart, 300); // after the reply
      return ok;
    });

    // demo players: up to 8, made-up names, they play from the next question on
    guestAction('host:addBots', () => {
      if (!ctx.config.demo) return fail('forbidden');
      let added = 0;
      for (const [name, country, side] of BOT_PEOPLE) {
        const result = ctx.guests.add({ name, country, side });
        if (!result.ok) continue; // already there (added before)
        bots.add(result.guest.id);
        ctx.quiz.addPlayer(result.guest.id, name);
        ctx.warmup.quiz?.addPlayer(result.guest.id, name);
        added++;
      }
      botQuestion = ''; // a running question: the new players answer it too
      broadcastSoon();
      ctx.log.info({ added }, 'demo players added');
      return { ok: true, added };
    });

    guestAction('host:addGuest', (payload) => {
      if (!isRecord(payload)) return fail('invalid-input');
      const result = ctx.guests.add(payload);
      if (!result.ok) return result;
      ctx.log.info({ guestId: result.guest.id }, 'guest added');
      return { ok: true, guestId: result.guest.id };
    });

    guestAction('host:unlinkBand', (payload) => {
      if (!isRecord(payload)) return fail('invalid-input');
      const code = normalizeCode(payload.code);
      const owner = code ? own(ctx.collect.state.bands, code) : undefined;
      if (!code || !owner) return fail('unknown-band');
      ctx.collect.releaseBand(code);
      for (const s of ctx.sessions.sidsOf(owner)) sendToSession(s);
      return ok;
    });
  });

  // a restart in the middle of a question: the auto-reveal carries on from the snapshot
  armAutoReveal();

  return {
    io,
    broadcast,
    close: () => {
      closed = true;
      ctx.snapshots.onWritten = undefined;
      clearTimeout(countsTimer);
      clearTimeout(guestsTimer);
      clearTimeout(answeredTimer);
      clearTimeout(everyoneTimer);
      clearTimeout(revealTimer);
      for (const t of botTimers) clearTimeout(t);
    },
  };
}
