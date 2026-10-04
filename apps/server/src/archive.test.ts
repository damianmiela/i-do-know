import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Localized } from '@idoknow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GameArchive, gameCsv, gameRecord, isGameId, pastOnScreen } from './archive';
import { Quiz, type Question } from './game/quiz';

const t = (en: string): Localized => ({ pl: en, es: en, ca: en, de: en, en });
const q = (id: string): Question => ({
  id,
  kind: 'choice',
  text: t(`Question ${id}`),
  options: [t('a'), t('b'), t('c')],
  correct: 1,
});

/** A finished game: ann right and fast, bob wrong, cid never answered, q2 skipped. */
function played() {
  const quiz = new Quiz([q('q1'), q('q2')], undefined, false, 20);
  quiz.addPlayer('ann', 'Ann');
  quiz.addPlayer('bob', '=HYPERLINK("x")');
  quiz.addPlayer('cid', 'Cid, "the third"');
  quiz.start(0);
  quiz.answer('ann', 1, 2_000);
  quiz.answer('bob', 2, 1_000);
  quiz.next(5_000);
  quiz.next(5_000);
  quiz.next(6_000);
  quiz.answer('ann', 0, 7_000);
  quiz.skip(8_000);
  expect(quiz.state.phase).toBe('final');
  const country = (id: string) => (id === 'ann' ? 'PL' : undefined);
  return gameRecord(quiz, country, 20, Date.UTC(2026, 8, 12, 21, 15, 3));
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idoknow-games-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('the game record', () => {
  it('has the questions as played, every answer (fastest first) and the ranking', () => {
    const g = played();
    expect(g.questions.map((x) => [x.id, x.skipped, x.correct])).toEqual([
      ['q1', false, 1],
      ['q2', true, 1],
    ]);
    expect(g.questions[0]!.answers).toEqual([
      { playerId: 'bob', name: '=HYPERLINK("x")', option: 2, elapsedMs: 1_000, points: 0 },
      { playerId: 'ann', name: 'Ann', option: 1, elapsedMs: 2_000, points: 950 },
    ]);
    expect(g.questions[1]!.answers).toEqual([
      { playerId: 'ann', name: 'Ann', option: 0, elapsedMs: 1_000, points: 0 },
    ]);
    expect(g.players[0]).toEqual({
      id: 'ann',
      name: 'Ann',
      country: 'PL',
      rank: 1,
      score: 950,
      correctCount: 1,
    });
    expect(g.players).toHaveLength(3);
  });
});

describe('the archive folder', () => {
  it('saves, lists (newest first), reads and deletes games', () => {
    const archive = new GameArchive(join(dir, 'games'));
    expect(archive.list()).toEqual([]);
    const first = archive.save(played());
    expect(first).toBe('2026-09-12T21-15-03Z');
    const second = archive.save(played()); // same second: a new name, never overwritten
    expect(second).toBe('2026-09-12T21-15-03Z-2');
    const later = archive.save({ ...played(), finishedAt: Date.UTC(2026, 8, 13) });
    expect(archive.list().map((g) => g.id)).toEqual([later, second, first]);
    expect(archive.list()[0]).toMatchObject({ playerCount: 3, questionCount: 2, winners: ['Ann'] });
    expect(archive.list()[0]?.setName).toBeUndefined();
    const set = archive.save({ ...played(), finishedAt: Date.UTC(2026, 8, 14), setName: 'Family' });
    expect(archive.list()[0]).toMatchObject({ id: set, setName: 'Family' });
    expect(archive.delete(set)).toBe(true);
    expect(archive.get(first)?.players[0]?.name).toBe('Ann');
    expect(readdirSync(join(dir, 'games')).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(archive.delete(first)).toBe(true);
    expect(archive.delete(first)).toBe(false);
    expect(archive.get(first)).toBeUndefined();
  });

  it('refuses ids that could leave the folder, and skips broken files', () => {
    const archive = new GameArchive(dir);
    for (const id of ['../snapshot', '..', 'x', '2026-09-12T21-15-03Z/../../a', '__proto__']) {
      expect(isGameId(id)).toBe(false);
      expect(archive.get(id)).toBeUndefined();
      expect(archive.delete(id)).toBe(false);
    }
    writeFileSync(join(dir, '2026-01-01T00-00-00Z.json'), '{broken');
    writeFileSync(join(dir, 'notes.json'), '{}');
    // valid on top, broken inside (a hand edit): skipped, the other games still list (audit 9)
    const bad = { version: 1, finishedAt: 1, questions: [], players: [null] };
    writeFileSync(join(dir, '2026-01-02T00-00-00Z.json'), JSON.stringify(bad));
    const badAnswer = { ...played(), questions: [{ ...played().questions[0], answers: [5] }] };
    writeFileSync(join(dir, '2026-01-03T00-00-00Z.json'), JSON.stringify(badAnswer));
    expect(archive.list()).toEqual([]);
    const good = archive.save(played());
    expect(archive.list().map((g) => g.id)).toEqual([good]);
  });
});

describe('the big screen and the spreadsheet', () => {
  it('shows the top 10, or one question with its votes', () => {
    const g = { ...played(), id: 'g' };
    expect(pastOnScreen(g)?.top?.map((r) => r.name)).toEqual([
      'Ann',
      '=HYPERLINK("x")',
      'Cid, "the third"',
    ]);
    const votes = pastOnScreen(g, 0)?.votes;
    expect(votes).toMatchObject({ optionCounts: [0, 1, 1], correctOption: 1 });
    expect(votes?.question).not.toHaveProperty('correct');
    expect(pastOnScreen(g, 5)).toBeUndefined();
  });

  it('one row per question and player; formulas and commas are made harmless', () => {
    const csv = gameCsv({ ...played(), id: 'g' });
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines).toHaveLength(1 + 2 * 3);
    expect(lines[1]).toBe('1,Question q1,Ann,b,yes,2.0,950,');
    expect(csv).toContain(`"'=HYPERLINK(""x"")",c,no,1.0,0,`);
    expect(csv).toContain('"Cid, ""the third""",,,,0,');
    expect(lines[6]).toMatch(/^2,Question q2,.*,yes$/); // skipped
  });
});
