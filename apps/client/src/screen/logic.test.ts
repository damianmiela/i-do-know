import { describe, expect, it } from 'vitest';
import { LANGS, type RankRow } from '@idoknow/shared';
import {
  answeredShare,
  capNames,
  confetti,
  isLocalOnly,
  isNewcomer,
  joinText,
  podiumSlots,
  rankingScroll,
  stageScale,
  startSlots,
  textFit,
  voteHeights,
} from './logic';
import { st } from './texts';

const row = (rank: number, name: string): RankRow => ({ rank, name, score: 1000 - rank });

describe('stageScale', () => {
  it('fits 1920×1080 into any window', () => {
    expect(stageScale(1920, 1080)).toBe(1);
    expect(stageScale(1280, 720)).toBeCloseTo(2 / 3);
    expect(stageScale(1024, 768)).toBeCloseTo(1024 / 1920); // 4:3 projector: bars top and bottom
    expect(stageScale(3840, 1080)).toBe(1); // ultra-wide: bars left and right
    expect(stageScale(0, 0)).toBe(1);
  });
});

describe('podiumSlots', () => {
  const top = [row(1, 'Ann'), row(2, 'Bob'), row(3, 'Cid')];

  it('shows 2nd, 1st, 3rd and reveals 3rd first', () => {
    expect(podiumSlots(top, 0).map((s) => [s.place, s.shown])).toEqual([
      [2, false],
      [1, false],
      [3, false],
    ]);
    expect(podiumSlots(top, 1).map((s) => s.shown)).toEqual([false, false, true]);
    expect(podiumSlots(top, 2).map((s) => s.shown)).toEqual([true, false, true]);
    expect(podiumSlots(top, 3).map((s) => s.shown)).toEqual([true, true, true]);
  });

  it('puts players sharing a place together, and leaves missing places empty', () => {
    const tie = podiumSlots([row(1, 'Ann'), row(1, 'Bob')], 3);
    expect(tie.find((s) => s.place === 1)?.rows.map((r) => r.name)).toEqual(['Ann', 'Bob']);
    expect(tie.find((s) => s.place === 2)?.rows).toEqual([]);
  });
});

describe('voteHeights', () => {
  it('scales to the biggest vote, with a sliver for zero', () => {
    expect(voteHeights([0, 10, 5, 0], 200)).toEqual([8, 200, 100, 8]);
    expect(voteHeights([0, 0], 200)).toEqual([8, 8]);
  });
});

describe('the join link', () => {
  it('is the address the screen was opened at, without https://', () => {
    expect(joinText('idoknow.dendigital.de')).toBe('idoknow.dendigital.de/join');
    expect(joinText('192.168.1.23:3210')).toBe('192.168.1.23:3210/join');
  });

  it('knows addresses phones can never open', () => {
    for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) {
      expect(isLocalOnly(h)).toBe(true);
    }
    for (const h of ['192.168.1.23', 'idoknow.dendigital.de', '10.0.0.5', 'localhost.example']) {
      expect(isLocalOnly(h)).toBe(false);
    }
  });

  it('the answered bar never overflows', () => {
    expect(answeredShare(62, 94)).toBeCloseTo(0.66, 2);
    expect(answeredShare(3, 0)).toBe(0);
    expect(answeredShare(5, 4)).toBe(1); // a player left after answering
  });
});

describe('screen texts', () => {
  it('exist in every language with their placeholders filled', () => {
    for (const lang of LANGS) {
      expect(st(lang, 'questionOf', { n: 3, total: 15 })).toMatch(/3.*15/);
      expect(st(lang, 'answeredWord')).not.toBe('');
      expect(st(lang, 'joiningSoon')).not.toBe('');
      expect(st(lang, 'afterQuestion', { n: 5, total: 15 })).toMatch(/5.*15/);
    }
  });

  it('pick plural forms by count', () => {
    expect(st('en', 'joined', { n: 1 })).toBe('guest has joined');
    expect(st('en', 'joined', { n: 87 })).toBe('guests have joined');
    expect(st('pl', 'joined', { n: 1 })).toBe('gość dołączył');
    expect(st('pl', 'joined', { n: 3 })).toBe('goście dołączyli');
    expect(st('pl', 'joined', { n: 87 })).toBe('gości dołączyło');
    expect(st('de', 'joined', { n: 2 })).toBe('Gäste sind dabei');
  });
});

describe('textFit', () => {
  it('gives long texts a smaller size', () => {
    expect(textFit('Where did they meet?', ['At work', 'At a party'])).toBe('');
    expect(textFit('x'.repeat(120), ['a'])).toBe('long');
    expect(textFit('short', ['y'.repeat(30)])).toBe('long');
    expect(textFit('x'.repeat(160), ['a'])).toBe('xlong');
    expect(textFit('short', ['y'.repeat(50)])).toBe('xlong');
  });
});

describe('capNames', () => {
  it('shows at most three names per podium place, then "+N"', () => {
    expect(capNames([1, 2])).toEqual({ shown: [1, 2], more: 0 });
    expect(capNames([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({ shown: [1, 2, 3], more: 5 });
  });
});

describe('Top 10 animation', () => {
  const r = (rank: number, prevRank?: number): RankRow => ({
    rank,
    name: `P${rank}`,
    score: 100 - rank,
    ...(prevRank !== undefined ? { prevRank } : {}),
  });

  it('opens in the old order: every row starts on its previous row', () => {
    // now: A (was 3rd), B (was 1st), C (was 2nd), D (new in the list)
    const rows = [r(1, 3), r(2, 1), r(3, 2), r(4, 14)];
    expect(startSlots(rows)).toEqual([2, 0, 1, 3]);
    expect(rows.map((row) => isNewcomer(row))).toEqual([false, false, false, true]);
  });

  it('keeps the order for ties and players who just joined', () => {
    expect(startSlots([r(1, 1), r(1, 1), r(3)])).toEqual([0, 1, 2]);
    expect(isNewcomer(r(3))).toBe(true);
  });
});

describe('confetti', () => {
  it('is the same every time and stays on the stage', () => {
    expect(confetti(20, 6)).toEqual(confetti(20, 6));
    for (const p of confetti(200, 6)) {
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left).toBeLessThanOrEqual(100);
      expect(p.color).toBeLessThan(6);
    }
  });
});

describe('count-up', () => {
  it('waits, runs from start to end, and stays at the end', async () => {
    const { countAt, easeOut } = await import('../motion');
    expect(countAt(100, 900, 0, 500, 1000)).toBe(100); // still waiting
    expect(countAt(100, 900, 500, 500, 1000)).toBe(100);
    expect(countAt(100, 900, 1000, 500, 1000)).toBeCloseTo(100 + 800 * easeOut(0.5));
    expect(countAt(100, 900, 5000, 500, 1000)).toBe(900);
    expect(countAt(900, 100, 1500, 500, 1000)).toBe(100); // counting down works too
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });
});

describe('the full ranking loop', () => {
  it('holds at the top, scrolls down slowly, holds, comes back up fast, repeats', () => {
    const max = 7_000; // about 100 rows
    expect(rankingScroll(0, max)).toBe(0);
    expect(rankingScroll(4_900, max)).toBe(0);
    const down = 35_000; // 7000 px at 200 px/s
    expect(rankingScroll(5_000 + down / 2, max)).toBeCloseTo(3_500);
    expect(rankingScroll(5_000 + down + 4_000, max)).toBe(max);
    const back = 5_000 + down + 5_000;
    expect(rankingScroll(back + 750, max)).toBeCloseTo(3_500);
    const cycle = back + 1_500;
    expect(rankingScroll(cycle + 100, max)).toBe(0); // and again
  });

  it('short lists stay put; reduce motion pages instead', () => {
    expect(rankingScroll(20_000, 0)).toBe(0);
    expect(rankingScroll(20_000, -50)).toBe(0);
    expect(rankingScroll(0, 2_000, 800, true)).toBe(0);
    expect(rankingScroll(5_000, 2_000, 800, true)).toBe(800);
    expect(rankingScroll(15_000, 2_000, 800, true)).toBe(2_000);
    expect(rankingScroll(20_000, 2_000, 800, true)).toBe(0);
  });
});
