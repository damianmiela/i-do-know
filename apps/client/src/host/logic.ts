// The host panel's decisions, as pure functions (tested); the components only draw.
import {
  MAIN_SET,
  WARMUP_LIST,
  type HostQuestion,
  type HostQuestionLists,
  PODIUM_STEPS,
  TIMER_MAX_SEC,
  TIMER_MIN_SEC,
  type ArchivedQuestion,
  type HostView,
} from '@idoknow/shared';

/** Actions that move the game on: sent with the step they were tapped at (see `stale`). */
export const STEP_EVENTS = [
  'host:pause',
  'host:resume',
  'host:start',
  'host:next',
  'host:skip',
  'host:restart',
  'host:startWarmup',
  'host:endWarmup',
  'host:podiumNext',
  'host:showRanking',
  'host:showAnswers',
  'host:coupleNext',
] as const;
export type StepEvent = (typeof STEP_EVENTS)[number];

/** The game buttons: every one of them is a step action. */
export type HostEvent = StepEvent;

/** One answer on a confirmation sheet. */
export interface Choice {
  label: string;
  tone?: 'danger' | 'caution';
  run: () => void;
}
/** A question before doing something that can't be undone (a sheet on the phone). */
export interface Ask {
  title: string;
  body: string;
  choices: Choice[];
}

export interface Confirm {
  title: string;
  body: string;
  /** The confirm button's text. */
  yes: string;
  /** Red for what can't be undone, amber for what only disturbs. */
  tone: 'danger' | 'caution';
}

export interface NextAction {
  event: HostEvent | null;
  /** What the big button will do. */
  label: string;
  /** Small line under it: what comes after. */
  then?: string;
  confirm?: Confirm;
}

/**
 * The podium place the next tap really reveals. Like the server (nextPodiumStep), places nobody
 * holds are skipped: players with 0 points never stand on the podium.
 */
export function nextPodiumPlace(view: HostView): number | null {
  if (view.podiumShown >= PODIUM_STEPS) return null;
  const held = new Set(
    (view.top ?? []).filter((r) => r.score > 0 && r.rank <= PODIUM_STEPS).map((r) => r.rank),
  );
  for (let step = view.podiumShown + 1; step <= PODIUM_STEPS; step++) {
    const place = PODIUM_STEPS + 1 - step;
    if (held.has(place)) return place;
  }
  return null; // nobody scored: one tap ends the podium
}

const PLACE_LABELS: Record<number, string> = {
  3: 'Reveal 3rd place',
  2: 'Reveal 2nd place',
  1: 'Reveal the winner',
};

/**
 * The big gold button: always the one next step, and it says what it will do.
 * The warm-up round runs the same steps and ends with "End warm-up".
 */
export function nextAction(view: HostView, untranslated = 0): NextAction {
  const last = view.questionNumber >= view.questionCount;
  const practice = view.warmup ? 'practice ' : '';
  switch (view.phase) {
    case 'lobby':
      // guests must never see a missing translation (the server refuses the start as well)
      if (untranslated > 0) {
        return {
          event: null,
          label: 'Complete the translations first',
          then: `${untranslated} ${untranslated === 1 ? 'question misses' : 'questions miss'} languages (Questions)`,
        };
      }
      return {
        event: 'host:start',
        label: 'Start the quiz',
        then: `Question 1 of ${view.questionCount}`,
        confirm: {
          title: 'Start the quiz now?',
          body: `${view.playerCount} ${view.playerCount === 1 ? 'guest has' : 'guests have'} joined. After the start, guests can no longer change their own name.${view.joiningOpen ? '' : ' Joining is closed: nobody new can join until you open it (Joining panel).'}`,
          yes: 'Start the quiz',
          tone: 'caution',
        },
      };
    case 'question': {
      // reading time (Phase 9.5): the room reads the question; the answers wait for this tap
      if (view.reading) {
        return {
          event: 'host:showAnswers',
          label: 'Show the answers',
          then: 'when everyone has read the question · the countdown starts',
        };
      }
      const after = last
        ? `then: ${view.warmup ? 'practice results' : 'the podium'}`
        : 'then: Top 10';
      return {
        event: 'host:next',
        label: 'Reveal the answer',
        // auto-reveal: a tap is still allowed (earlier than the automatic one)
        then: view.autoReveal ? `or by itself when time is up / all answered · ${after}` : after,
      };
    }
    case 'reveal':
      return last
        ? {
            event: 'host:next',
            label: view.warmup ? 'Show the practice results' : 'Go to the podium',
          }
        : { event: 'host:next', label: 'Show the Top 10' };
    case 'leaderboard':
      return {
        event: 'host:next',
        label: `Next ${practice}question`,
        then: `Question ${view.questionNumber + 1} of ${view.questionCount}`,
      };
    case 'final':
      // the warm-up plays its podium too (Phase 6.10), then ends
      if (view.warmup && view.podiumShown >= PODIUM_STEPS) {
        return { event: 'host:endWarmup', label: 'End the warm-up', then: 'back to the lobby' };
      }
      if (view.podiumShown < PODIUM_STEPS) {
        const place = nextPodiumPlace(view);
        if (place === null) {
          return { event: 'host:podiumNext', label: 'Close the podium', then: 'nobody scored' };
        }
        // places skipped because nobody holds them (fewer scorers, or a tie)
        const expected = PODIUM_STEPS - view.podiumShown;
        const skipped = expected - place;
        const then =
          skipped === 0
            ? undefined
            : place === 2
              ? 'nobody is 3rd'
              : skipped === 2
                ? 'nobody is 2nd or 3rd'
                : 'nobody is 2nd';
        return { event: 'host:podiumNext', label: PLACE_LABELS[place]!, ...(then ? { then } : {}) };
      }
      if (view.overallRounds) {
        return { event: null, label: 'Round finished', then: 'the overall ranking is shown' };
      }
      if (!view.ranking) {
        return {
          event: 'host:showRanking',
          label: 'Show the full ranking',
          then: 'everyone on the big screen and on every phone',
        };
      }
      // the couple played along (Phase 9.5): their answers, question by question, then the summary
      if (view.coupleRound && !view.warmup) {
        const c = view.couple;
        if (!c) {
          return {
            event: 'host:coupleNext',
            label: "The couple's answers",
            then: 'question by question on the big screen and the phones',
          };
        }
        if (!c.summary) {
          return (c.n ?? 0) < c.total
            ? {
                event: 'host:coupleNext',
                label: `Couple: question ${(c.n ?? 0) + 1} of ${c.total}`,
              }
            : {
                event: 'host:coupleNext',
                label: 'Show how well they know each other',
                then: 'the summary',
              };
        }
        return { event: null, label: 'Quiz finished', then: "the couple's summary is shown" };
      }
      return { event: null, label: 'Quiz finished', then: 'the full ranking is shown' };
  }
}

/** "Question 5 of 15 · 9 s left", "Waiting room", … */
export function phaseLine(view: HostView, secondsLeft: number): string {
  const round = view.warmup ? 'Practice ' : '';
  const q = `${round}Question ${view.questionNumber} of ${view.questionCount}`;
  switch (view.phase) {
    case 'lobby':
      return 'Waiting room';
    case 'question':
      if (view.reading) return `${q} · reading time`;
      return view.paused ? `${q} · paused` : `${q} · ${secondsLeft} s left`;
    case 'reveal':
      return `${q} · answer revealed`;
    case 'leaderboard':
      return `${q} · Top 10`;
    case 'final':
      // the warm-up has its podium too (Phase 6.10)
      return `${round}Podium · ${Math.min(view.podiumShown, PODIUM_STEPS)} of ${PODIUM_STEPS} places revealed`;
  }
}

/** "saved 3 s ago", or null while nothing was saved yet. */
export function savedLine(savedAgoMs: number | undefined, sinceViewMs: number): string | null {
  if (savedAgoMs === undefined) return null;
  const s = Math.floor((savedAgoMs + Math.max(sinceViewMs, 0)) / 1000);
  if (s < 60) return `saved ${s} s ago`;
  return `saved ${Math.floor(s / 60)} min ago`;
}

/** Guests who picked a name but have no open connection right now (both counts are guests). */
export const notConnected = (view: HostView) =>
  Math.max(0, view.joinedGuests - view.connectedGuests);

/** Folded text for the host's guest search (same idea as the phones' search). */
export function matches(name: string, query: string, fold: (s: string) => string): boolean {
  const q = fold(query).trim();
  return q === '' || fold(name).includes(q);
}

/**
 * The timer field: a whole number of seconds the server accepts, or null. Accepts "90" and
 * "90 s"; "1:30" means minutes and seconds.
 */
export function parseTimer(input: string): number | null {
  const t = input
    .trim()
    .toLowerCase()
    .replace(/\s*s(ec(onds?)?)?$/, '');
  const mmss = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  const sec = mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : /^\d{1,4}$/.test(t) ? Number(t) : NaN;
  return Number.isInteger(sec) && sec >= TIMER_MIN_SEC && sec <= TIMER_MAX_SEC ? sec : null;
}

/** "60 s", "1 min 30 s", "3 min". */
export function timerLabel(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * A past game can go on the big screen only in the waiting room or after the quiz (never over a
 * podium still being revealed).
 */
export const canShowPast = (view: HostView) =>
  !view.warmup &&
  (view.phase === 'lobby' || (view.phase === 'final' && view.podiumShown >= PODIUM_STEPS));

/** "Sat 12 Sep 2026, 21:15" in the host's own time zone. */
export const gameWhen = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

/** How many picked each option of an archived question. */
export function voteCounts(q: ArchivedQuestion): number[] {
  const counts = q.options.map(() => 0);
  for (const a of q.answers) counts[a.option] = (counts[a.option] ?? 0) + 1;
  return counts;
}

/** "4.2 s" */
export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** One question list for the pickers: the main quiz, the warm-up, or an extra set (Phase 6.10). */
export interface ListEntry {
  id: string;
  name: string;
  questions: HostQuestion[];
  /** The bride and groom answer too, off the leaderboard (Phase 9.5; never the warm-up). */
  couple?: boolean;
}

/** Every list in the order the editor shows them. */
export const allLists = (lists: HostQuestionLists): ListEntry[] => [
  {
    id: MAIN_SET,
    name: 'Main quiz',
    questions: lists.questions,
    ...(lists.couple ? { couple: true } : {}),
  },
  { id: WARMUP_LIST, name: 'Warm-up', questions: lists.warmup },
  ...lists.sets,
];

/** The lists a round can play (not the warm-up). */
export const roundLists = (lists: HostQuestionLists): ListEntry[] =>
  allLists(lists).filter((l) => l.id !== WARMUP_LIST);

/** The questions of one list (empty for an unknown one, e.g. a set just deleted). */
export const questionsOf = (lists: HostQuestionLists, id: string): HostQuestion[] =>
  allLists(lists).find((l) => l.id === id)?.questions ?? [];
