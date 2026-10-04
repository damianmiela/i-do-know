import type { GuestView } from '@idoknow/shared';
import { describe, expect, it } from 'vitest';
import {
  fitsScreen,
  isLongText,
  isTimeUp,
  newestOnly,
  rankMove,
  screenFor,
  secondsShown,
  shortName,
  startRows,
  symbolFor,
  timeLeft,
  timeShare,
  type LocalState,
} from './logic';

const view = (extra: Partial<GuestView> = {}): GuestView => ({
  phase: 'lobby',
  questionNumber: 0,
  questionCount: 3,
  timeLeftMs: 0,
  paused: false,
  playerCount: 10,
  joined: true,
  joiningOpen: true,
  ...extra,
});
const local = (extra: Partial<LocalState> = {}): LocalState => ({
  refused: false,
  langChosen: true,
  timeUp: false,
  ...extra,
});

describe('screenFor', () => {
  it('joining is language, then name, then the waiting room', () => {
    expect(screenFor(null, local())).toBe('connecting');
    expect(screenFor(view({ joined: false }), local({ langChosen: false }))).toBe('language');
    expect(screenFor(view({ joined: false }), local())).toBe('search');
    expect(screenFor(view(), local())).toBe('lobby');
  });

  it('joining closed: a phone without a name waits ("too early"), a guest with one plays on', () => {
    const closed = view({ joined: false, joiningOpen: false });
    expect(screenFor(closed, local({ langChosen: false }))).toBe('too-early');
    expect(screenFor(closed, local())).toBe('too-early');
    expect(screenFor(view({ joiningOpen: false }), local())).toBe('lobby');
    expect(screenFor(view({ joiningOpen: false, phase: 'question' }), local())).toBe('question');
  });

  it('never sends a guest with a name back to the language step', () => {
    // e.g. storage blocked: the phone forgot the language choice after a reload
    expect(screenFor(view({ phase: 'question' }), local({ langChosen: false }))).toBe('question');
    expect(screenFor(view(), local({ langChosen: false }))).toBe('lobby');
  });

  it("shows time's up only without an answer; an answer keeps the question on screen", () => {
    expect(screenFor(view({ phase: 'question' }), local({ timeUp: true }))).toBe('time-up');
    expect(screenFor(view({ phase: 'question', myAnswer: 1 }), local({ timeUp: true }))).toBe(
      'question',
    );
  });

  it('a refused device always sees "scan again"', () => {
    expect(screenFor(view(), local({ refused: true }))).toBe('scan-again');
    expect(screenFor(null, local({ refused: true }))).toBe('scan-again');
  });

  it('follows the quiz phases', () => {
    expect(screenFor(view({ phase: 'question' }), local())).toBe('question');
    expect(screenFor(view({ phase: 'question', myAnswer: 2 }), local())).toBe('question');
    expect(screenFor(view({ phase: 'reveal', myPoints: 0 }), local())).toBe('reveal');
    expect(screenFor(view({ phase: 'leaderboard', myPoints: 800 }), local())).toBe('leaderboard');
    expect(screenFor(view({ phase: 'final' }), local())).toBe('final');
  });

  it('someone who joined after the reveal waits for the next question', () => {
    expect(screenFor(view({ phase: 'reveal' }), local())).toBe('wait');
    expect(screenFor(view({ phase: 'leaderboard' }), local())).toBe('wait');
  });
});

describe('countdown', () => {
  it('counts down locally from when the view arrived, and stops at 0', () => {
    const v = { timeLeftMs: 15_000, paused: false };
    expect(timeLeft(v, 1_000, 1_000)).toBe(15_000);
    expect(timeLeft(v, 1_000, 6_000)).toBe(10_000);
    expect(timeLeft(v, 1_000, 99_000)).toBe(0);
    expect(timeLeft(v, 1_000, 500)).toBe(15_000); // clock oddities never add time
  });

  it('stands still during the reading time (Phase 9.5)', () => {
    const v = { timeLeftMs: 20_000, paused: false, reading: true as const };
    expect(timeLeft(v, 1_000, 60_000)).toBe(20_000);
  });

  it("time's up only after the countdown and the grace for late taps", () => {
    const v = { timeLeftMs: 5_000, paused: false, phase: 'question' as const };
    expect(isTimeUp(v, 0, 6_999)).toBe(false);
    expect(isTimeUp(v, 0, 7_000)).toBe(true);
    expect(isTimeUp({ ...v, paused: true }, 0, 60_000)).toBe(false);
    expect(isTimeUp({ ...v, phase: 'reveal' }, 0, 60_000)).toBe(false);
  });

  it('is frozen while paused', () => {
    expect(timeLeft({ timeLeftMs: 7_000, paused: true }, 0, 60_000)).toBe(7_000);
  });

  it('shows whole seconds rounded up and a capped bar', () => {
    expect([15_000, 14_001, 900, 0].map(secondsShown)).toEqual([15, 15, 1, 0]);
    expect(timeShare(10_000, 20)).toBe(0.5);
    expect(timeShare(25_000, 20)).toBe(1); // after "+10 s"
  });
});

describe('rankMove and symbols', () => {
  it('positive means up', () => {
    expect(rankMove(10, 7)).toBe(3);
    expect(rankMove(7, 12)).toBe(-5);
    expect(rankMove(undefined, 3)).toBeUndefined();
  });

  it('keeps the same colour/symbol order as the big screen', () => {
    expect([0, 1, 2, 3].map((i) => symbolFor('choice', i))).toEqual([
      'heart',
      'flower',
      'star',
      'moon',
    ]);
    expect([0, 1].map((i) => symbolFor('bride-or-groom', i))).toEqual(['heart', 'star']);
  });
});

describe('newestOnly', () => {
  it('ignores replies to older search queries', () => {
    const seq = newestOnly();
    const first = seq.next();
    const second = seq.next();
    expect(seq.isLatest(first)).toBe(false);
    expect(seq.isLatest(second)).toBe(true);
  });
});

describe('one screen high', () => {
  it('the question and time-up screens never scroll; the rest may', () => {
    expect(fitsScreen('question')).toBe(true);
    expect(fitsScreen('time-up')).toBe(true);
    expect(fitsScreen('final')).toBe(false); // the full ranking scrolls
    expect(fitsScreen('search')).toBe(false); // the keyboard needs room
  });

  it('long questions get smaller type', () => {
    expect(isLongText('Who is the better cook?')).toBe(false);
    expect(isLongText('x'.repeat(91))).toBe(true);
  });
});

describe('phone ranking helpers (Phase 6.10)', () => {
  it('first name plus the initial of the last name', () => {
    expect(shortName('Łukasz Wiśniewski')).toBe('Łukasz W.');
    expect(shortName('Núria Puigdomènech Vidal')).toBe('Núria V.');
    expect(shortName('  Jürgen   weiß ')).toBe('Jürgen W.');
    expect(shortName('Cher')).toBe('Cher');
    expect(shortName('')).toBe('');
    // suffixes, brackets, quotes and emoji are not a last name (audit 9)
    expect(shortName('Jan Kowalski (senior)')).toBe('Jan K.');
    expect(shortName('Jan Kowalski senior')).toBe('Jan K.');
    expect(shortName('Jan Kowalski Jr.')).toBe('Jan K.');
    expect(shortName('Anna "Ania"')).toBe('Anna');
    expect(shortName('Zoë 🇵🇱')).toBe('Zoë');
    expect(shortName('María de la Cruz')).toBe('María C.');
  });

  it('rows start where they stood before and slide into the new order', () => {
    // new order: B (was 3rd), A (was 1st), C (was 2nd), D (new)
    const rows = [{ prevRank: 3 }, { prevRank: 1 }, { prevRank: 2 }, {}];
    expect(startRows(rows)).toEqual([2, 0, 1, 3]);
  });
});
