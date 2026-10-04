// The phone's decisions, as pure functions (unit-tested): which screen to show, the countdown,
// rank changes and answer symbols. The components only draw what these return.
import { ANSWER_GRACE_MS, type GuestView, type QuestionKind } from '@idoknow/shared';

/** How long the phone waits for a reply to an action before giving up (weak roaming data). */
export const REPLY_TIMEOUT_MS = 10_000;
/** After this long without a reply to a tap, the phone says "not sent yet… still trying". */
export const SLOW_REPLY_MS = 4_000;

export type Screen =
  | 'scan-again' // no valid session (e.g. the cookie was cleared): open the join link again
  | 'connecting' // first connection not made yet
  | 'too-early' // no name yet, and the host hasn't opened joining: waits, then goes on by itself
  | 'language' // joining, step 1
  | 'search' // joining, step 2: find your name
  | 'lobby' // you're in, waiting for the quiz
  | 'question' // also after answering: the question stays, with your answer marked
  | 'time-up' // the countdown (plus the grace) ran out without an answer
  | 'reveal'
  | 'wait' // joined after the reveal: wait for the next question
  | 'leaderboard'
  | 'final';

export interface LocalState {
  /** The server refused this device (connect_error "unauthorized": no valid guest cookie). */
  refused: boolean;
  /** The guest confirmed a language on this phone. */
  langChosen: boolean;
  /** The local countdown plus the grace ran out (see isTimeUp). */
  timeUp: boolean;
}

/** Joining is: language → name → waiting room. Nothing else stands between a guest and the quiz. */
export function screenFor(view: GuestView | null, local: LocalState): Screen {
  if (local.refused) return 'scan-again';
  if (!view) return 'connecting';
  // the language step only while joining: a guest with a name is never sent back to it
  // (e.g. when the phone can't remember settings and the page reloads mid-quiz)
  if (!view.joined) {
    if (!view.joiningOpen) return 'too-early';
    return local.langChosen ? 'search' : 'language';
  }
  switch (view.phase) {
    case 'lobby':
      return 'lobby';
    case 'question':
      if (view.myAnswer !== undefined) return 'question';
      return local.timeUp ? 'time-up' : 'question';
    case 'reveal':
      return view.myPoints === undefined ? 'wait' : 'reveal';
    case 'leaderboard':
      return view.myPoints === undefined ? 'wait' : 'leaderboard';
    case 'final':
      return 'final';
  }
}

/**
 * Screens laid out as exactly one screen high (Phase 6.9, Damian: "we cannot have" scrolling on
 * a question): the photo and the answer tiles share what's left. The other screens may scroll.
 */
export const fitsScreen = (screen: Screen) => screen === 'question' || screen === 'time-up';

/** A question text long enough to get smaller type on the phone (it must leave room for the tiles). */
export const LONG_TEXT = 90;
export const isLongText = (text: string) => text.length > LONG_TEXT;

/**
 * Milliseconds left, counted down on the phone from the server's `timeLeftMs`, measured when
 * the view arrived (`receivedAt`, same clock as `now`). Frozen while paused.
 */
export function timeLeft(
  view: Pick<GuestView, 'timeLeftMs' | 'paused' | 'reading'>,
  receivedAt: number,
  now: number,
): number {
  // paused, or the reading time before the answers (Phase 9.5): the clock stands still
  if (view.paused || view.reading) return view.timeLeftMs;
  return Math.max(view.timeLeftMs - Math.max(now - receivedAt, 0), 0);
}

/**
 * The answer window is really over: the countdown reached 0 and the server's grace for late taps
 * has passed too (never while paused).
 */
export function isTimeUp(
  view: Pick<GuestView, 'timeLeftMs' | 'paused' | 'phase'>,
  receivedAt: number,
  now: number,
): boolean {
  if (view.phase !== 'question' || view.paused) return false;
  return now - receivedAt >= view.timeLeftMs + ANSWER_GRACE_MS;
}

/** Share of the countdown left, 0..1, for the gold bar ("+10 s" can make it longer: capped). */
export function timeShare(leftMs: number, limitSec: number): number {
  return Math.min(Math.max(leftMs / (limitSec * 1000), 0), 1);
}

/** Whole seconds shown on the chip: rounds up, so "0 s" appears only when time is really up. */
export const secondsShown = (leftMs: number) => Math.ceil(leftMs / 1000);

/** Places moved since the last reveal: positive = up. Undefined if unknown. */
export function rankMove(prevRank?: number, rank?: number): number | undefined {
  return prevRank === undefined || rank === undefined ? undefined : prevRank - rank;
}

export type Symbol = 'heart' | 'flower' | 'star' | 'moon';
const SYMBOLS: readonly Symbol[] = ['heart', 'flower', 'star', 'moon'];

/**
 * Colour and symbol of an answer. Always the same order, so the phone matches the big screen.
 * Bride-or-groom: Anna is always the heart and Ben always the star.
 */
export function symbolFor(kind: QuestionKind, index: number): Symbol {
  if (kind === 'bride-or-groom') return index === 0 ? 'heart' : 'star';
  return SYMBOLS[index] ?? 'heart';
}

/**
 * Search replies can arrive out of order on a bad connection. Each query gets a number; only
 * the reply to the newest one is used.
 */
export function newestOnly() {
  let latest = 0;
  return {
    next: () => ++latest,
    isLatest: (n: number) => n === latest,
  };
}

/** Words after a surname that are not a name ("Jan Kowalski senior", "… Jr."). */
const NAME_SUFFIX = /^(senior|junior|sen|jun|sr|jr|ii|iii|iv)\.?$/i;

/**
 * The name in the phone's top bar: the first name and the initial of the last one ("Łukasz W.",
 * "Núria Puigdomènech Vidal" → "Núria V.", Damian's rule). One word stays as it is. Only words
 * starting with a letter count, and suffixes are skipped ("Jan Kowalski (senior)" → "Jan K.",
 * "Anna \"Ania\"" → "Anna"; audit 9).
 */
export function shortName(full: string): string {
  const words = full.trim().split(/\s+/).filter(Boolean);
  const last = words
    .slice(1)
    .filter((w) => /^\p{L}/u.test(w) && !NAME_SUFFIX.test(w))
    .at(-1);
  if (!last) return words[0] ?? '';
  return `${words[0]} ${Array.from(last)[0]!.toLocaleUpperCase()}.`;
}

/**
 * The phone's own part of the ranking between questions (Phase 6.10) opens in the previous
 * order and slides into the new one, like the big screen's Top 10: the row each player stood on
 * before (by previous place). Rows without a previous place come last (they rise in from below).
 */
export function startRows(rows: readonly { prevRank?: number }[]): number[] {
  const order = rows
    .map((r, i) => ({ i, prev: r.prevRank ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.prev - b.prev || a.i - b.i);
  const slots: number[] = new Array<number>(rows.length).fill(0);
  order.forEach((o, slot) => (slots[o.i] = slot));
  return slots;
}
