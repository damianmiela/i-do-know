import {
  LANGS,
  missingLangs,
  questionProblems,
  type Localized,
  type PublicQuestion,
  type QuestionKind,
  type QuizError,
  type QuizPhase,
} from '@idoknow/shared';
import {
  ACTIVE_WINDOW,
  ADD_TIME_MAX_MS,
  ANSWER_GRACE_MS,
  DEFAULT_TIME_LIMIT_SEC,
  EXTRA_TIME_TOTAL_MAX_MS,
  MAX_POINTS,
  MIN_POINTS,
} from './config';
import { cleanRecord, isNum, isSafeKey, own } from './safe';

export interface Question {
  id: string;
  kind: QuestionKind;
  text: Localized;
  /** 2 to 4 options. For bride-or-groom exactly 2: [bride, groom]. */
  options: Localized[];
  /** Index into options. SECRET: never send this to clients before the reveal. */
  correct: number;
  /** Photo file name (required for photo questions). */
  photo?: string;
}

export interface Player {
  id: string;
  name: string;
  score: number;
  correctCount: number;
  /** Sum of answer times of correct answers; lower wins a tie on score. */
  correctTimeMs: number;
  /** How many questions were played when the player joined (see activePlayers). */
  since?: number;
}

export interface Answer {
  option: number;
  elapsedMs: number;
  /** Countdown length when the answer was given, so a later "+10 s" doesn't change its points. */
  limitMs: number;
}

/** One answer in the log: which option, when (ms after the question opened), points won. */
export interface LoggedAnswer {
  option: number;
  elapsedMs: number;
  points: number;
}

/** What happened in one question of the game (for the archive, Phase 6.8). */
export interface QuestionLog {
  questionId: string;
  /** When the question opened (ms since epoch). */
  openedAt: number;
  /** The host skipped it: nobody got points (the answers given are still kept). */
  skipped: boolean;
  answers: Record<string, LoggedAnswer>;
}

/**
 * Plain JSON: this is what gets snapshotted to disk.
 * SECRET: contains everyone's answers. Never emit it to clients as-is.
 */
export interface QuizState {
  phase: QuizPhase;
  /** Current question index, -1 in the lobby. */
  index: number;
  /** Id of the current question, to detect a snapshot that no longer matches questions.json. */
  questionId: string | null;
  /** When the current question opened (ms since epoch). */
  startedAt: number;
  /** Extra time the host added to the current question. */
  extraMs: number;
  /** Set while the countdown is paused. */
  pausedAt: number | null;
  /** Total paused time in the current question. */
  pausedMs: number;
  /**
   * Reading time (Phase 9.5): the question is shown without its answers and the countdown
   * stands still until the host shows the answers. Missing in older snapshots = false.
   */
  reading?: boolean;
  /** Answers to the current question, by player id. */
  answers: Record<string, Answer>;
  /**
   * Points each player got at the last reveal (0 = wrong or no answer).
   * Players who joined after that reveal have no entry: the phone shows "wait for the next question".
   */
  lastPoints: Record<string, number>;
  /** Each player's rank just before the last reveal, for "▲ 3 places". Missing for later joiners. */
  prevRanks: Record<string, number>;
  players: Record<string, Player>;
  /** Every question played so far, with every answer (the archive's source). */
  log: QuestionLog[];
}

export type { QuizError };

export type Result = { ok: true } | { ok: false; error: QuizError };

export interface RankedPlayer extends Player {
  /** 1-based; players with identical score and time share a rank. */
  rank: number;
}

const ok: Result = { ok: true };
const fail = (error: QuizError): Result => ({ ok: false, error });

/** Linear 1000 → 500 over the countdown. */
export function pointsFor(elapsedMs: number, limitMs: number): number {
  const t = Math.min(Math.max(elapsedMs / limitMs, 0), 1);
  return Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * t);
}

/** A plain image file name in content/photos: no folders, no "..". */
export { PHOTO_NAME } from '@idoknow/shared';

/**
 * Tidies questions read from questions.json. A file written by hand may leave out languages: they
 * become '' (a missing translation, see missingLangs), so a half-translated question loads as a
 * draft instead of stopping the server. A per-question `timeLimitSec` (before Phase 6.7) is
 * dropped: one timer counts for all questions.
 */
export function tidyQuestions(questions: unknown): unknown {
  if (!Array.isArray(questions)) return questions;
  const fill = (t: unknown) =>
    typeof t === 'object' && t !== null && !Array.isArray(t)
      ? Object.fromEntries(LANGS.map((l) => [l, (t as Record<string, unknown>)[l] ?? '']))
      : t;
  return questions.map((q: unknown) => {
    if (typeof q !== 'object' || q === null) return q;
    const r = { ...(q as Record<string, unknown>) };
    delete r.timeLimitSec;
    return {
      ...r,
      ...(r.text !== undefined ? { text: fill(r.text) } : {}),
      ...(Array.isArray(r.options) ? { options: r.options.map(fill) } : {}),
    };
  });
}

/** Checks a question list (e.g. from questions.json). Returns problems; empty = valid. */
export function validateQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions)) return ['questions must be an array'];
  const errors: string[] = [];
  const ids = new Set<string>();
  questions.forEach((raw: unknown, i) => {
    const q = raw as Partial<Question>;
    const at = `question ${i + 1} (${String(q?.id)})`;
    if (!isSafeKey(q?.id)) errors.push(`${at}: id missing or invalid`);
    else if (ids.has(q.id)) errors.push(`${at}: duplicate id`);
    else ids.add(q.id);
    for (const problem of questionProblems(raw)) errors.push(`${at}: ${problem}`);
  });
  return errors;
}

/** Questions that still miss a language: the quiz can't start with them. */
export const incomplete = (questions: readonly Question[]) =>
  questions.filter((q) => missingLangs(q).length > 0);

const PHASES: readonly QuizPhase[] = ['lobby', 'question', 'reveal', 'leaderboard', 'final'];

/** Rebuilds a quiz snapshot read from disk; throws if it isn't a valid quiz state. */
export function restoreQuizState(raw: unknown): QuizState {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid snapshot: quiz state');
  const r = raw as Record<string, unknown>;
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`Invalid snapshot: ${what}`);
  };
  need(PHASES.includes(r.phase as QuizPhase), 'phase');
  need(Number.isInteger(r.index) && (r.index as number) >= -1, 'index');
  need(r.questionId === null || isSafeKey(r.questionId), 'questionId');
  need(isNum(r.startedAt) && isNum(r.extraMs) && isNum(r.pausedMs), 'timer');
  need(r.pausedAt === null || isNum(r.pausedAt), 'pausedAt');
  return {
    phase: r.phase as QuizPhase,
    index: r.index as number,
    questionId: r.questionId as string | null,
    startedAt: r.startedAt as number,
    extraMs: r.extraMs as number,
    pausedAt: r.pausedAt as number | null,
    pausedMs: r.pausedMs as number,
    ...(r.reading === true && r.phase === 'question' ? { reading: true } : {}),
    players: cleanRecord<Player>(
      r.players,
      (v, key) => {
        const p = v as Partial<Player>;
        return (
          typeof p === 'object' &&
          p !== null &&
          p.id === key &&
          typeof p.name === 'string' &&
          isNum(p.score) &&
          isNum(p.correctCount) &&
          isNum(p.correctTimeMs) &&
          (p.since === undefined || isNum(p.since))
        );
      },
      'players',
    ),
    answers: cleanRecord<Answer>(
      r.answers,
      (v) => {
        const a = v as Partial<Answer>;
        return (
          typeof a === 'object' &&
          a !== null &&
          Number.isInteger(a.option) &&
          isNum(a.elapsedMs) &&
          isNum(a.limitMs) &&
          a.limitMs > 0
        );
      },
      'answers',
    ),
    lastPoints: cleanRecord<number>(r.lastPoints, isNum, 'lastPoints'),
    prevRanks: cleanRecord<number>(r.prevRanks, isNum, 'prevRanks'),
    // snapshots from before Phase 6.8 have no log
    log: r.log === undefined ? [] : restoreLog(r.log),
  };
}

function restoreLog(raw: unknown): QuestionLog[] {
  if (!Array.isArray(raw)) throw new Error('Invalid snapshot: log');
  return raw.map((entry: unknown, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (!isSafeKey(e.questionId) || !isNum(e.openedAt) || typeof e.skipped !== 'boolean') {
      throw new Error(`Invalid snapshot: log ${i}`);
    }
    return {
      questionId: e.questionId,
      openedAt: e.openedAt,
      skipped: e.skipped,
      answers: cleanRecord<LoggedAnswer>(
        e.answers,
        (v) => {
          const a = v as Partial<LoggedAnswer>;
          return (
            typeof a === 'object' &&
            a !== null &&
            Number.isInteger(a.option) &&
            isNum(a.elapsedMs) &&
            isNum(a.points)
          );
        },
        `log ${i} answers`,
      ),
    };
  });
}

export function initialQuizState(): QuizState {
  return {
    phase: 'lobby',
    index: -1,
    questionId: null,
    startedAt: 0,
    extraMs: 0,
    pausedAt: null,
    pausedMs: 0,
    answers: {},
    lastPoints: {},
    prevRanks: {},
    players: {},
    log: [],
  };
}

/**
 * The quiz state machine: lobby → question → reveal → (leaderboard) → question … → final.
 * All methods take `now` explicitly so the logic is deterministic and testable.
 * The constructor throws on invalid questions or a snapshot that doesn't match them:
 * call it at startup, never inside a socket handler.
 */
export class Quiz {
  constructor(
    readonly questions: readonly Question[],
    readonly state: QuizState = initialQuizState(),
    /** A warm-up round: plays like the quiz, but its points never count. */
    readonly warmup = false,
    /** The countdown of every question (the host's setting). */
    readonly timeLimitSec = DEFAULT_TIME_LIMIT_SEC,
  ) {
    const errors = validateQuestions(questions);
    if (errors.length) throw new Error(`Invalid questions:\n${errors.join('\n')}`);
    if (state.index >= 0 && questions[state.index]?.id !== state.questionId) {
      throw new Error(
        `Snapshot is at question ${state.index + 1} (${state.questionId}) but questions.json has changed`,
      );
    }
  }

  get question(): Question | undefined {
    return this.questions[this.state.index];
  }

  /** The current question without the answer, safe to send to clients. */
  publicQuestion(): PublicQuestion | undefined {
    const q = this.question;
    if (!q) return undefined;
    return {
      id: q.id,
      kind: q.kind,
      text: q.text,
      options: q.options,
      timeLimitSec: this.timeLimitSec,
      ...(q.photo ? { photo: q.photo } : {}),
    };
  }

  /** Adds a player, or does nothing if they already exist (reconnects keep their score). */
  addPlayer(id: string, name: string): Result {
    if (!isSafeKey(id)) return fail('invalid-player');
    if (!own(this.state.players, id)) {
      this.state.players[id] = {
        id,
        name,
        score: 0,
        correctCount: 0,
        correctTimeMs: 0,
        since: this.state.log.length,
      };
    }
    return ok;
  }

  /**
   * Removes a player (a guest who picked the wrong name and changes it before the quiz). The
   * caller decides when that's allowed: the real quiz only allows it in the lobby.
   */
  removePlayer(id: string): void {
    const s = this.state;
    for (const record of [s.players, s.answers, s.lastPoints, s.prevRanks]) {
      if (Object.hasOwn(record, id)) delete (record as Record<string, unknown>)[id];
    }
    // a removed guest's answers leave the game's record too (Phase 6.9: "the score goes too")
    for (const entry of s.log) {
      if (Object.hasOwn(entry.answers, id)) delete entry.answers[id];
    }
  }

  /** `readFirst`: open the first question with reading time (Phase 9.5, the host's switch). */
  start(now: number, readFirst = false): Result {
    if (this.state.phase !== 'lobby') return fail('wrong-phase');
    if (this.questions.length === 0) return fail('no-questions');
    this.openQuestion(0, now, readFirst);
    return ok;
  }

  /** The host shows the answers after the reading time: the countdown starts now, from full. */
  showAnswers(now: number): Result {
    const s = this.state;
    if (s.phase !== 'question' || !s.reading) return fail('wrong-phase');
    delete s.reading;
    s.startedAt = now;
    s.pausedAt = null;
    s.pausedMs = 0;
    return ok;
  }

  limitMs(): number {
    return this.timeLimitSec * 1000 + this.state.extraMs;
  }

  elapsedMs(now: number): number {
    const s = this.state;
    // never negative, even if a timestamp arrives from just before the question opened
    return Math.max((s.pausedAt ?? now) - s.startedAt - s.pausedMs, 0);
  }

  timeLeftMs(now: number): number {
    return Math.max(this.limitMs() - this.elapsedMs(now), 0);
  }

  answer(playerId: string, option: number, now: number): Result {
    const s = this.state;
    if (s.phase !== 'question' || s.reading) return fail('wrong-phase');
    if (!own(s.players, playerId)) return fail('unknown-player');
    if (s.pausedAt !== null) return fail('paused');
    const q = this.question!;
    if (!Number.isInteger(option) || option < 0 || option >= q.options.length) {
      return fail('invalid-option');
    }
    if (own(s.answers, playerId)) return fail('already-answered');
    const elapsedMs = this.elapsedMs(now);
    const limitMs = this.limitMs();
    // Taps delayed by a slow network still count (at the minimum points, pointsFor clamps).
    if (elapsedMs >= limitMs + ANSWER_GRACE_MS) return fail('time-up');
    s.answers[playerId] = { option, elapsedMs, limitMs };
    return ok;
  }

  pause(now: number): Result {
    const s = this.state;
    if (s.phase !== 'question' || s.pausedAt !== null || s.reading) return fail('wrong-phase');
    s.pausedAt = now;
    return ok;
  }

  resume(now: number): Result {
    const s = this.state;
    if (s.phase !== 'question' || s.pausedAt === null || s.reading) return fail('wrong-phase');
    // a clock that jumped backwards must not give the countdown time back
    s.pausedMs += Math.max(now - s.pausedAt, 0);
    s.pausedAt = null;
    return ok;
  }

  /** Host "+10 s". Positive whole milliseconds, capped, so a bad value can't break the countdown. */
  addTime(ms: number): Result {
    if (this.state.phase !== 'question') return fail('wrong-phase');
    if (!Number.isInteger(ms) || ms <= 0 || ms > ADD_TIME_MAX_MS) return fail('invalid-time');
    if (this.state.extraMs + ms > EXTRA_TIME_TOTAL_MAX_MS) return fail('invalid-time');
    this.state.extraMs += ms;
    return ok;
  }

  /**
   * The host's NEXT button. What it does depends on the phase. `readFirst`: the next question
   * opens with reading time (Phase 9.5).
   */
  next(now: number, readFirst = false): Result {
    const s = this.state;
    const last = s.index >= this.questions.length - 1;
    switch (s.phase) {
      case 'question':
        // during the reading time the answers must be shown first (or the question skipped)
        if (s.reading) return fail('wrong-phase');
        this.reveal();
        return ok;
      case 'reveal':
        // the Top 10 after every question; after the last one straight to the podium (a Top 10
        // there would give the winners away)
        s.phase = last ? 'final' : 'leaderboard';
        return ok;
      case 'leaderboard':
        this.openQuestion(s.index + 1, now, readFirst);
        return ok;
      default:
        return fail('wrong-phase');
    }
  }

  /** Drops the current question: nobody gets points, go straight to the next one. */
  skip(now: number, readFirst = false): Result {
    const s = this.state;
    if (s.phase !== 'question') return fail('wrong-phase');
    this.logQuestion(true, () => 0);
    s.answers = {};
    delete s.reading;
    s.pausedAt = null; // a question skipped while paused (or reading) leaves no stopped clock
    if (s.index >= this.questions.length - 1) s.phase = 'final';
    else this.openQuestion(s.index + 1, now, readFirst);
    return ok;
  }

  /** Back to the lobby with all scores reset. Players stay joined. */
  restart(): void {
    const players = Object.values(this.state.players);
    Object.assign(this.state, initialQuizState());
    for (const p of players) this.addPlayer(p.id, p.name);
  }

  /**
   * The players still taking part (Phase 6.9, Damian: "active players"): those who answered at
   * least one of the last ACTIVE_WINDOW questions. Before that many questions were played
   * (for the game, or since a player joined), everyone counts.
   */
  activePlayers(): string[] {
    const s = this.state;
    const recent = s.log.slice(-ACTIVE_WINDOW);
    const all = Object.values(s.players);
    const active = all.filter(
      (p) =>
        s.log.length - (p.since ?? 0) < ACTIVE_WINDOW ||
        recent.some((entry) => Object.hasOwn(entry.answers, p.id)),
    );
    // nobody answered lately (two skips, a network drop): everyone counts again, so the first
    // answer never ends the question for all
    return (active.length ? active : all).map((p) => p.id);
  }

  /** Every active player has answered the running question (and somebody did). */
  everyoneAnswered(): boolean {
    const s = this.state;
    if (s.phase !== 'question' || Object.keys(s.answers).length === 0) return false;
    return this.activePlayers().every((id) => Object.hasOwn(s.answers, id));
  }

  /** Score desc, then correct-answer time asc. */
  /**
   * Players who play but never stand in a ranking (Phase 9.5: the bride and groom, when the
   * couple plays along). They score as usual; `ranking(true)` includes them ("would have been").
   */
  offBoard: ReadonlySet<string> = new Set();

  ranking(withOffBoard = false): RankedPlayer[] {
    const players = Object.values(this.state.players).filter(
      (p) => withOffBoard || !this.offBoard.has(p.id),
    );
    const sorted = players.sort(
      (a, b) =>
        b.score - a.score || a.correctTimeMs - b.correctTimeMs || a.name.localeCompare(b.name),
    );
    let rank = 0;
    return sorted.map((p, i) => {
      const prev = sorted[i - 1];
      if (!prev || prev.score !== p.score || prev.correctTimeMs !== p.correctTimeMs) rank = i + 1;
      return { ...p, rank };
    });
  }

  private reveal(): void {
    const s = this.state;
    const q = this.question!;
    // before anyone has points everyone "shares 1st place": that is no place to move from
    // (else nearly everyone would get a ▼ after the first question)
    const anyPoints = Object.values(s.players).some((p) => p.score > 0);
    s.prevRanks = anyPoints ? Object.fromEntries(this.ranking().map((p) => [p.id, p.rank])) : {};
    s.lastPoints = {};
    for (const p of Object.values(s.players)) {
      const a = own(s.answers, p.id);
      const points = a && a.option === q.correct ? pointsFor(a.elapsedMs, a.limitMs) : 0;
      s.lastPoints[p.id] = points;
      if (points > 0 && a) {
        p.score += points;
        p.correctCount += 1;
        p.correctTimeMs += a.elapsedMs;
      }
    }
    this.logQuestion(false, (id) => s.lastPoints[id] ?? 0);
    s.pausedAt = null;
    delete s.reading;
    s.phase = 'reveal';
  }

  /** Keeps the current question's answers in the log (the archive's source). */
  private logQuestion(skipped: boolean, pointsOf: (playerId: string) => number): void {
    const s = this.state;
    const answers: Record<string, LoggedAnswer> = {};
    for (const [id, a] of Object.entries(s.answers)) {
      answers[id] = { option: a.option, elapsedMs: a.elapsedMs, points: pointsOf(id) };
    }
    s.log.push({ questionId: this.question!.id, openedAt: s.startedAt, skipped, answers });
  }

  private openQuestion(index: number, now: number, readFirst: boolean): void {
    Object.assign(this.state, {
      phase: 'question',
      index,
      questionId: this.questions[index]!.id,
      startedAt: now,
      extraMs: 0,
      // reading time: the countdown stands still (full) until showAnswers()
      pausedAt: readFirst ? now : null,
      pausedMs: 0,
      answers: {},
    } satisfies Partial<QuizState>);
    if (readFirst) this.state.reading = true;
    else delete this.state.reading;
  }
}
