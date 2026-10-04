// What each client is allowed to see. The ONLY place that turns game state into payloads:
// never emit QuizState or a raw Question (they hold correct answers and everyone's picks).
import {
  PODIUM_STEPS,
  TOP_COUNT,
  type CoupleSlide,
  type EventInfo,
  type GuestView,
  type HostGuestRow,
  type HostQuestion,
  type HostView,
  type Lang,
  type PastOnScreen,
  type QuizViewBase,
  type RankRow,
  type RoundResult,
  type ScreenView,
} from '@idoknow/shared';
import type { Collect, Guest } from './game/collect';
import { own } from './game/safe';
import type { Question, Quiz, RankedPlayer } from './game/quiz';
import type { GuestBook } from './guests';
import type { SessionStore } from './sessions';

/** The bride and groom as marked in guests.json (Phase 9.5). */
export interface Couple {
  bride?: Guest;
  groom?: Guest;
}

/**
 * The couple's review (Phase 9.5): slide `step` (0-based) of the questions played (not skipped),
 * with the bride's and the groom's answers; `step` = the number of questions is the summary.
 * Only after the round is over (the caller checks): nothing in it is secret any more.
 */
export function coupleSlide(quiz: Quiz, couple: Couple, step: number): CoupleSlide {
  const played = quiz.state.log.filter((e) => !e.skipped);
  const total = played.length;
  const whole = quiz.ranking(true);
  const pickOf = (g: Guest | undefined, answers: Record<string, { option: number }>) =>
    g
      ? { name: g.name, ...(own(answers, g.id) ? { option: own(answers, g.id)!.option } : {}) }
      : undefined;
  const entry = played[step];
  const q = entry && quiz.questions.find((x) => x.id === entry.questionId);
  if (entry && q) {
    const bride = pickOf(couple.bride, entry.answers);
    const groom = pickOf(couple.groom, entry.answers);
    return {
      total,
      n: step + 1,
      question: {
        id: q.id,
        kind: q.kind,
        text: q.text,
        options: q.options,
        timeLimitSec: quiz.timeLimitSec,
        ...(q.photo ? { photo: q.photo } : {}),
        correct: q.correct,
      },
      ...(bride ? { bride } : {}),
      ...(groom ? { groom } : {}),
    };
  }
  // the summary: right answers, answers alike, and (for fun) the place each would have had
  const correctOf = (id: string) =>
    played.filter((e) => {
      const a = own(e.answers, id);
      return (
        a !== undefined && a.option === quiz.questions.find((x) => x.id === e.questionId)?.correct
      );
    }).length;
  const scoreOf = (g: Guest | undefined) => {
    if (!g) return undefined;
    const rank = whole.find((p) => p.id === g.id)?.rank;
    return {
      name: g.name,
      correct: correctOf(g.id),
      ...(rank !== undefined ? { wouldRank: rank } : {}),
    };
  };
  const both =
    couple.bride && couple.groom
      ? played.filter((e) => own(e.answers, couple.bride!.id) && own(e.answers, couple.groom!.id))
      : [];
  const bride = scoreOf(couple.bride);
  const groom = scoreOf(couple.groom);
  return {
    total,
    summary: {
      ...(bride ? { bride } : {}),
      ...(groom ? { groom } : {}),
      bothAnswered: both.length,
      agreed: both.filter(
        (e) =>
          own(e.answers, couple.bride!.id)!.option === own(e.answers, couple.groom!.id)!.option,
      ).length,
    },
  };
}

/** Ranking by player id, computed once per broadcast. */
export type Ranks = ReadonlyMap<string, RankedPlayer>;

export function ranksOf(quiz: Quiz): Ranks {
  return new Map(quiz.ranking().map((p) => [p.id, p]));
}

function base(quiz: Quiz, now: number): QuizViewBase {
  const s = quiz.state;
  const question =
    s.phase === 'question' || s.phase === 'reveal' ? quiz.publicQuestion() : undefined;
  // reading time (Phase 9.5): the question alone; the answers come when the host shows them,
  // so nobody can read (or tap) ahead
  const reading = s.phase === 'question' && s.reading === true;
  return {
    phase: s.phase,
    ...(reading ? { reading: true as const } : {}),
    questionNumber: s.index + 1,
    questionCount: quiz.questions.length,
    ...(question ? { question: reading ? { ...question, options: [] } : question } : {}),
    timeLeftMs: s.phase === 'question' ? quiz.timeLeftMs(now) : 0,
    // the reading time stops the clock too, but it isn't a pause (phones say "get ready")
    paused: s.phase === 'question' && s.pausedAt !== null && !reading,
    playerCount: Object.keys(s.players).length,
    // the answer is public only once revealed
    ...(s.phase === 'reveal' ? { correctOption: quiz.question!.correct } : {}),
    ...(quiz.warmup ? { warmup: true } : {}),
  };
}

/**
 * The places are the big screen's news: from the last question's reveal until the host has
 * revealed the whole podium, phones don't show them (the winner would know before the room).
 */
export function placesHidden(quiz: Quiz, podiumShown: number): boolean {
  // the warm-up plays the podium too (Damian: "so people know what's up")
  const s = quiz.state;
  const last = s.index >= quiz.questions.length - 1;
  return (s.phase === 'reveal' && last) || (s.phase === 'final' && podiumShown < PODIUM_STEPS);
}

/**
 * The podium step after `shown`: reveals the next place (3rd, 2nd, 1st), skipping places nobody
 * holds (fewer than 3 players, or a shared place). PODIUM_STEPS = everything is shown.
 * Players with 0 points never stand on the podium (in a small test game they all share a place).
 */
export function nextPodiumStep(quiz: Quiz, shown: number): number {
  const held = new Set(
    quiz
      .ranking()
      .filter((p) => p.score > 0)
      .map((p) => p.rank),
  );
  let step = shown;
  do step++;
  while (step < PODIUM_STEPS && !held.has(PODIUM_STEPS + 1 - step));
  return Math.min(step, PODIUM_STEPS);
}

/**
 * Where the game is, as a short key: round, phase, question, podium places. The host panel sends
 * it back with every step action; a tap made at an older step is refused (`stale`).
 */
export function stepOf(quiz: Quiz, podiumShown: number, round = 0): string {
  const s = quiz.state;
  const podium = s.phase === 'final' ? podiumShown : 0;
  // `round` goes up with every warm-up start/end and restart: a sheet left open from an
  // earlier round can never match the same question of a later one
  const phase = s.phase === 'question' && s.reading ? 'reading' : s.phase;
  return `${round}.${quiz.warmup ? 'w' : 'q'}.${phase}.${s.index}.${podium}`;
}

/** The step plus whether the question is paused (pause and resume carry this). */
export const pauseStepOf = (quiz: Quiz, podiumShown: number, round = 0) =>
  `${stepOf(quiz, podiumShown, round)}.${quiz.state.pausedAt === null ? 'r' : 'p'}`;

export interface GuestExtras {
  /** This guest's own wristband code, if linked. */
  band?: string;
  /** Podium places revealed on the big screen (see placesHidden). */
  podiumShown?: number;
  /** New guests may pick a name (the host's switch). */
  joiningOpen?: boolean;
  /** The full ranking the host shows after the podium, or the overall one (see rankingRows). */
  ranking?: readonly RankingRow[];
  /** `ranking` is the overall one, over this many rounds. */
  overallRounds?: number;
  /** Rounds played so far (the waiting room says "the next round" then). */
  roundsPlayed?: number;
  /** The couple's review after the full ranking (Phase 9.5). */
  couple?: CoupleSlide;
}

/** Places shown above and below a phone's own row between questions (Phase 6.10). */
export const AROUND = 3;

/**
 * A phone's own neighbourhood in the ranking between questions: up to AROUND places above and
 * below, with the last question's points (for the same slide and count-up as the big screen).
 */
function around(quiz: Quiz, guestId: string, ranks: Ranks): RankRow[] {
  const order = [...ranks.values()]; // the ranking's order (ranksOf keeps it)
  const i = order.findIndex((p) => p.id === guestId);
  if (i < 0) return [];
  const s = quiz.state;
  return order.slice(Math.max(0, i - AROUND), i + AROUND + 1).map((p) => {
    const prevRank = own(s.prevRanks, p.id);
    const gained = own(s.lastPoints, p.id);
    return {
      rank: p.rank,
      name: p.name,
      score: p.score, // no flag: phones don't show it (audit 9: send only what is used)
      ...(prevRank !== undefined ? { prevRank } : {}),
      ...(gained !== undefined ? { gained } : {}),
      ...(p.id === guestId ? { me: true as const } : {}),
    };
  });
}

/** One guest's phone. `guestId` is null while the device hasn't picked its name. */
export function guestView(
  quiz: Quiz,
  guestId: string | null,
  ranks: Ranks,
  now: number,
  {
    band,
    podiumShown = 0,
    joiningOpen = false,
    ranking,
    overallRounds,
    roundsPlayed,
    couple,
  }: GuestExtras = {},
): GuestView {
  const s = quiz.state;
  const running = s.phase === 'question' || s.phase === 'reveal';
  const view: GuestView = {
    ...base(quiz, now),
    joined: false,
    joiningOpen,
    // "62 of 94 guests have answered" under the answers
    ...(running ? { answeredCount: Object.keys(s.answers).length } : {}),
  };
  const me = guestId === null ? undefined : own(s.players, guestId);
  if (!guestId || !me) return view;
  const answer = own(s.answers, guestId);
  const afterReveal = s.phase === 'reveal' || s.phase === 'leaderboard' || s.phase === 'final';
  const points = afterReveal ? own(s.lastPoints, guestId) : undefined;
  const prevRank = afterReveal ? own(s.prevRanks, guestId) : undefined;
  // the bride or groom playing along (Phase 9.5): no place, no points, no neighbours
  const offBoard = quiz.offBoard.has(guestId);
  const hidden = placesHidden(quiz, podiumShown) || offBoard;
  return {
    ...view,
    joined: true,
    // photos download in the waiting room, so photo questions show at once later (only for
    // guests with a name: anyone can open the join link, and the photos are private)
    ...(s.phase === 'lobby' ? { photos: quiz.questions.flatMap((q) => q.photo ?? []) } : {}),
    name: me.name,
    ...(band ? { band } : {}),
    correctCount: me.correctCount,
    ...(offBoard ? { offBoard: true as const } : {}),
    ...(hidden
      ? { rankHidden: true }
      : {
          score: me.score,
          rank: ranks.get(guestId)?.rank ?? ranks.size,
          ...(prevRank !== undefined ? { prevRank } : {}),
        }),
    ...(answer && running ? { myAnswer: answer.option } : {}),
    // "Answered in 5.1 s": the server's time, the one that counts for points and ties
    ...(answer && running ? { myAnswerMs: answer.elapsedMs } : {}),
    ...(points !== undefined ? { myPoints: points } : {}),
    // everyone's place, this guest's own row marked (no ids: phones never learn guest ids)
    // everyone's place (the caller decides when: after the podium, or the overall ranking)
    ...(ranking
      ? {
          ranking: ranking.map((r) => ({
            rank: r.rank,
            name: r.name,
            score: r.score, // no id (phones never learn guest ids) and no flag (not shown)
            ...(r.id === guestId ? { me: true as const } : {}),
          })),
        }
      : {}),
    ...(ranking && overallRounds ? { overallRounds } : {}),
    // between questions: you and your neighbours, like the big screen's Top 10
    ...(s.phase === 'leaderboard' && !offBoard ? { around: around(quiz, guestId, ranks) } : {}),
    ...(couple && s.phase === 'final' ? { couple } : {}),
    ...(s.phase === 'lobby' && !quiz.warmup && roundsPlayed ? { roundsPlayed } : {}),
  };
}

/** Looks up a player's country on the guest list (for the flag). */
export type CountryOf = (guestId: string) => string | undefined;

/** A full-ranking row with the player's id (server side only: the id is dropped before sending). */
export type RankingRow = RankRow & { id: string };

/**
 * Everyone's place after the podium (Phase 6.9): rank, name, points, flag. Built once per
 * broadcast; phones get it with their own row marked, the screen and host without ids.
 */
/**
 * The overall ranking (Phase 6.10): every round's points added up per player. Equal totals with
 * equal correct answers share a place.
 */
export function overallRows(rounds: readonly RoundResult[], countryOf: CountryOf): RankingRow[] {
  const totals = new Map<string, { name: string; score: number; correct: number }>();
  for (const round of rounds) {
    for (const [id, p] of Object.entries(round.players)) {
      const t = totals.get(id) ?? { name: p.name, score: 0, correct: 0 };
      totals.set(id, {
        name: p.name,
        score: t.score + p.score,
        correct: t.correct + p.correctCount,
      });
    }
  }
  const sorted = [...totals.entries()].sort(
    ([, a], [, b]) => b.score - a.score || b.correct - a.correct || a.name.localeCompare(b.name),
  );
  let rank = 0;
  return sorted.map(([id, t], i) => {
    const prev = sorted[i - 1]?.[1];
    if (!prev || prev.score !== t.score || prev.correct !== t.correct) rank = i + 1;
    const country = countryOf(id);
    return { id, rank, name: t.name, score: t.score, ...(country ? { country } : {}) };
  });
}

export function rankingRows(quiz: Quiz, countryOf: CountryOf): RankingRow[] {
  return quiz.ranking().map((p) => {
    const country = countryOf(p.id);
    return {
      id: p.id,
      rank: p.rank,
      name: p.name,
      score: p.score,
      ...(country ? { country } : {}),
    };
  });
}

const withoutIds = (rows: readonly RankingRow[]): RankRow[] =>
  rows.map((r) => ({
    rank: r.rank,
    name: r.name,
    score: r.score,
    ...(r.country ? { country: r.country } : {}),
  }));

function top(quiz: Quiz, countryOf: CountryOf): RankRow[] {
  const s = quiz.state;
  return quiz
    .ranking()
    .slice(0, TOP_COUNT)
    .map((p) => {
      const country = countryOf(p.id);
      const prevRank = own(s.prevRanks, p.id);
      const gained = own(s.lastPoints, p.id);
      return {
        rank: p.rank,
        name: p.name,
        score: p.score,
        ...(country ? { country } : {}),
        ...(prevRank !== undefined ? { prevRank } : {}),
        ...(gained !== undefined ? { gained } : {}),
      };
    });
}

/** What the big screen needs besides the quiz. */
export interface ScreenExtras {
  /** content/event.json: the screen gets its title, the host also the sides' names. */
  event: EventInfo;
  lang: Lang;
  joiningOpen: boolean;
  /** Podium places the host has revealed (counts only in the final phase). */
  podiumShown: number;
  countryOf: CountryOf;
  /** A past game the host shows instead of the live one (Phase 6.8). */
  past?: PastOnScreen;
  /** The full ranking the host shows after the podium (Phase 6.9), or the overall one. */
  ranking?: readonly RankingRow[];
  /** `ranking` is the overall one, over this many rounds (Phase 6.10). */
  overallRounds?: number;
  /** The podium part of the step key (podium places + 1 once the full ranking is out). */
  podiumKey?: number;
  /** The round's question set, when it isn't the main quiz. */
  roundName?: string;
  /** The couple's review after the full ranking (Phase 9.5). */
  couple?: CoupleSlide;
}

export function screenView(quiz: Quiz, now: number, extras: ScreenExtras): ScreenView {
  const s = quiz.state;
  const answers = Object.values(s.answers);
  const podiumShown = s.phase === 'final' ? extras.podiumShown : 0;
  const view: ScreenView = {
    ...base(quiz, now),
    ...(s.phase === 'lobby' ? { title: extras.event.title } : {}),
    answeredCount: s.phase === 'question' || s.phase === 'reveal' ? answers.length : 0,
    lang: extras.lang,
    joiningOpen: extras.joiningOpen,
    podiumShown,
    ...(extras.past ? { past: extras.past } : {}),
    ...(extras.ranking ? { ranking: withoutIds(extras.ranking) } : {}),
    ...(extras.ranking && extras.overallRounds ? { overallRounds: extras.overallRounds } : {}),
    ...(extras.roundName ? { roundName: extras.roundName } : {}),
    ...(extras.couple && s.phase === 'final' ? { couple: extras.couple } : {}),
  };
  if (s.phase === 'reveal') {
    const counts = quiz.question!.options.map(() => 0);
    for (const a of answers) counts[a.option] = (counts[a.option] ?? 0) + 1;
    view.optionCounts = counts;
  }
  if (s.phase === 'leaderboard') view.top = top(quiz, extras.countryOf);
  if (s.phase === 'final') {
    // the podium, revealed place by place (the warm-up too, Phase 6.10)
    const from = PODIUM_STEPS + 1 - podiumShown;
    view.top = top(quiz, extras.countryOf).filter(
      (r) => r.score > 0 && r.rank <= PODIUM_STEPS && r.rank >= from,
    );
  }
  return view;
}

export interface HostExtras extends ScreenExtras {
  connectedGuests: number;
  /** The public demo (DEMO_MODE). */
  demo?: boolean;
  /** The real event, switched from the demo. */
  eventMode?: boolean;
  warnings: readonly string[];
  notes: readonly string[];
  timeLimitSec: number;
  autoReveal: boolean;
  readingStep: boolean;
  activeSet: string;
  playedSets: string[];
  roundsPlayed: number;
  overallShown: boolean;
  warmupAvailable: boolean;
  joinedGuests: number;
  guestCount: number;
  /** Server time of the last save (null: not saved yet). */
  lastSavedAt: number | null;
  saveFailing: boolean;
  /** Counts warm-up starts/ends and restarts (see stepOf). */
  round: number;
  coupleMarked: { bride?: string; groom?: string };
  coupleRound: boolean;
}

/** Host only: the questions with their answers. Never send this to guests or the screen. */
export function hostQuestions(
  questions: readonly Question[],
  timeLimitSec: number,
): HostQuestion[] {
  return questions.map((q) => ({
    id: q.id,
    kind: q.kind,
    text: q.text,
    options: q.options,
    correct: q.correct,
    timeLimitSec,
    ...(q.photo ? { photo: q.photo } : {}),
  }));
}

export function hostView(quiz: Quiz, now: number, extras: HostExtras): HostView {
  const s = quiz.state;
  // the full ranking is one more step after the podium (the overall ranking isn't a step)
  const podiumKey =
    extras.podiumKey ?? extras.podiumShown + (extras.ranking && !extras.overallRounds ? 1 : 0);
  return {
    ...screenView(quiz, now, extras),
    ...(s.phase === 'question' || s.phase === 'reveal'
      ? { answerKey: quiz.question!.correct }
      : {}),
    // the host sees the whole top 10, also before the podium is revealed
    ...(s.phase === 'leaderboard' || s.phase === 'final'
      ? { top: top(quiz, extras.countryOf) }
      : {}),
    connectedGuests: extras.connectedGuests,
    sides: { ...extras.event.sides },
    ...(extras.demo ? { demo: true as const } : {}),
    ...(extras.eventMode ? { event: true as const } : {}),
    warnings: [...extras.warnings],
    notes: [...extras.notes],
    timeLimitSec: extras.timeLimitSec,
    autoReveal: extras.autoReveal,
    readingStep: extras.readingStep,
    activeSet: extras.activeSet,
    playedSets: extras.playedSets,
    roundsPlayed: extras.roundsPlayed,
    overallShown: extras.overallShown,
    warmupAvailable: extras.warmupAvailable,
    joinedGuests: extras.joinedGuests,
    guestCount: extras.guestCount,
    ...(extras.lastSavedAt !== null ? { savedAgoMs: Math.max(0, now - extras.lastSavedAt) } : {}),
    saveFailing: extras.saveFailing,
    coupleMarked: { ...extras.coupleMarked },
    coupleRound: extras.coupleRound,
    // the full ranking is one more step after the podium
    step: stepOf(quiz, podiumKey, extras.round),
    pauseStep: pauseStepOf(quiz, podiumKey, extras.round),
  };
}

/** Host only: every guest with claim, online and band status. */
export function hostGuestRows(
  guests: GuestBook,
  sessions: SessionStore,
  collect: Collect,
  onlineSids: ReadonlySet<string>,
): HostGuestRow[] {
  const bands = new Map(Object.entries(collect.state.bands).map(([code, id]) => [id, code]));
  return Object.values(guests.all)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => {
      const sids = sessions.sidsOf(g.id);
      const band = bands.get(g.id);
      return {
        id: g.id,
        name: g.name,
        country: g.country,
        side: g.side,
        claimed: sids.length > 0,
        online: sids.some((sid) => onlineSids.has(sid)),
        ...(band ? { band } : {}),
        added: guests.isAdded(g.id),
        ...(g.role ? { role: g.role } : {}),
      };
    });
}
