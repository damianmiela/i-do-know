// The big screen's decisions, as pure functions (tested); the components only draw.
import { JOIN_PATH, PODIUM_STEPS, TOP_COUNT, type RankRow } from '@idoknow/shared';

/** The screen is laid out once at 1920×1080 and scaled to fit any projector or TV. */
export const STAGE_WIDTH = 1920;
export const STAGE_HEIGHT = 1080;

/**
 * The join link as guests type it: the address this page was opened at, without "https://"
 * (e.g. "idoknow.dendigital.de/join"; while testing "192.168.1.23:3210/join").
 */
export const joinText = (host: string) => `${host}${JOIN_PATH}`;

/** Addresses only this computer can open: a QR code with one of them is useless for phones. */
export function isLocalOnly(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** Share of the players who answered, 0..1 (for the big screen's answered bar). */
export const answeredShare = (answered: number, players: number) =>
  players > 0 ? Math.min(Math.max(answered / players, 0), 1) : 0;

/** Scale that fits the whole stage into the window (letterboxed on other aspect ratios). */
export function stageScale(width: number, height: number): number {
  const s = Math.min(width / STAGE_WIDTH, height / STAGE_HEIGHT);
  return Number.isFinite(s) && s > 0 ? s : 1;
}

export interface PodiumSlot {
  place: number;
  /** Everyone on this place (usually one; more only on an exact tie). Empty until revealed. */
  rows: RankRow[];
  /** The host has revealed this place. */
  shown: boolean;
}

/**
 * The podium in display order: 2nd, 1st, 3rd (the winner in the middle). Places are revealed
 * from 3rd to 1st: `shown` steps reveal the places above PODIUM_STEPS - shown.
 */
export function podiumSlots(top: readonly RankRow[], shown: number): PodiumSlot[] {
  return [2, 1, 3].map((place) => ({
    place,
    rows: top.filter((r) => r.rank === place),
    shown: place > PODIUM_STEPS - shown,
  }));
}

/** Bar heights for the votes at the reveal: the biggest bar is `max` px, a vote shows at least a sliver. */
export function voteHeights(counts: readonly number[], max: number): number[] {
  const most = Math.max(0, ...counts);
  return counts.map((n) => (most === 0 ? 8 : Math.max(8, Math.round((n / most) * max))));
}

/**
 * Longer texts get a smaller font, so a German question with long answers still fits (the
 * question and every answer, in the screen's language). CSS also cuts off anything longer.
 */
export function textFit(question: string, options: readonly string[]): '' | 'long' | 'xlong' {
  const longest = Math.max(0, ...options.map((o) => o.length));
  if (question.length > 150 || longest > 45) return 'xlong';
  if (question.length > 100 || longest > 28) return 'long';
  return '';
}

/** At most `max` names per podium place (an exact tie is rare); the rest become "+N". */
export function capNames<T>(rows: readonly T[], max = 3): { shown: T[]; more: number } {
  return { shown: rows.slice(0, max), more: Math.max(0, rows.length - max) };
}

/**
 * Top 10 animation: the row each player stood on before the last question (by their previous
 * place), so the list can open in the old order and slide into the new one. Players who weren't
 * in the list before come last (they rise in from below).
 */
export function startSlots(rows: readonly RankRow[]): number[] {
  const order = rows
    .map((r, i) => ({ i, prev: r.prevRank ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.prev - b.prev || a.i - b.i);
  const slots: number[] = new Array<number>(rows.length).fill(0);
  order.forEach((o, slot) => (slots[o.i] = slot));
  return slots;
}

/** A player who wasn't in the previous Top 10 (or joined after it). */
export const isNewcomer = (row: RankRow, size = TOP_COUNT) =>
  row.prevRank === undefined || row.prevRank > size;

export interface ConfettiPiece {
  /** Horizontal start, % of the stage width. */
  left: number;
  delay: number;
  duration: number;
  /** Sideways drift while falling, px. */
  drift: number;
  spin: number;
  /** Index into the theme's confetti colours. */
  color: number;
  wide: boolean;
}

/** Confetti for the winner: always the same pieces (a seeded sequence, no Math.random). */
export function confetti(count: number, colors: number, seed = 7): ConfettiPiece[] {
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  return Array.from({ length: count }, () => ({
    left: Math.round(rnd() * 1000) / 10,
    delay: Math.round(rnd() * 1600),
    duration: 2600 + Math.round(rnd() * 2200),
    drift: Math.round((rnd() - 0.5) * 240),
    spin: Math.round(360 + rnd() * 720),
    color: Math.floor(rnd() * colors),
    wide: rnd() > 0.5,
  }));
}

/** The full ranking's endless loop on the big screen (Phase 6.9, Damian's timings). */
export const RANKING_HOLD_MS = 5_000;
export const RANKING_BACK_MS = 1_500;
/** About 100 rows scroll by in roughly 35 s; short lists never crawl. */
const rankingSpeed = (max: number) => Math.max(60, max / 35); // px per second

/**
 * How far the list is scrolled `t` ms into the loop: 5 s at the top, a slow scroll to the bottom,
 * 5 s at the bottom, a quick scroll back up, again. `max` = list height minus the visible height
 * (0 or less: everything fits, nothing moves). With `still` (reduce motion) it pages instead:
 * a whole screen at a time, every 5 s.
 */
export function rankingScroll(t: number, max: number, page = 0, still = false): number {
  if (max <= 0) return 0;
  if (still) {
    const pages = Math.ceil(max / Math.max(page, 1)) + 1;
    const n = Math.floor(Math.max(t, 0) / RANKING_HOLD_MS) % pages;
    return Math.min(n * page, max);
  }
  const down = (max / rankingSpeed(max)) * 1000;
  const cycle = RANKING_HOLD_MS + down + RANKING_HOLD_MS + RANKING_BACK_MS;
  let u = ((t % cycle) + cycle) % cycle;
  if (u < RANKING_HOLD_MS) return 0;
  u -= RANKING_HOLD_MS;
  if (u < down) return (u / down) * max;
  u -= down;
  if (u < RANKING_HOLD_MS) return max;
  u -= RANKING_HOLD_MS;
  const k = u / RANKING_BACK_MS; // ease in-out on the way back up
  const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
  return max * (1 - eased);
}
