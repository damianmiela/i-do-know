import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Localized } from '@idoknow/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from './auth';
import { initialCollectState, type Guest } from './game/collect';
import { initialQuizState, type Question } from './game/quiz';
import {
  loadGame,
  restoreSnapshot,
  SNAPSHOT_FILE,
  SNAPSHOT_PREV_FILE,
  SNAPSHOT_VERSION,
  SnapshotWriter,
  type Snapshot,
} from './snapshot';

const t = (en: string): Localized => ({ pl: en, es: en, ca: en, de: en, en });
const q = (id: string): Question => ({
  id,
  kind: 'choice',
  text: t(id),
  options: [t('a'), t('b')],
  correct: 1,
});
const questions = [q('q1'), q('q2')];
const listed: Guest[] = [
  { id: 'g001', name: 'Ann Example', country: 'PL', side: 'bride' },
  { id: 'g002', name: 'Bob Example', country: 'ES', side: 'groom' },
];

function snapshot(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: 1,
    quiz: initialQuizState(),
    collect: initialCollectState(),
    sessions: {},
    addedGuests: {},
    joiningOpen: true,
    ...extra,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'idoknow-snap-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe('restoreSnapshot', () => {
  it('accepts a valid snapshot', () => {
    const s = snapshot();
    expect(restoreSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('loads a version 2 file (random join link): the token is dropped, joining closed', () => {
    const v2: Record<string, unknown> = { ...snapshot(), version: 2, joinToken: newId(24) };
    delete v2.joiningOpen;
    expect(restoreSnapshot(JSON.parse(JSON.stringify(v2)))).toEqual({
      ...snapshot(),
      joiningOpen: false,
    });
  });

  it('rejects other versions, a missing switch and bad parts', () => {
    expect(() => restoreSnapshot({ ...snapshot(), version: 0 })).toThrow(/version/);
    expect(() => restoreSnapshot({ ...snapshot(), joiningOpen: 'yes' })).toThrow(/joiningOpen/);
    expect(() => restoreSnapshot({ ...snapshot(), quiz: {} })).toThrow(/Invalid snapshot/);
    // broken rounds only cost the overall ranking, never the saved game (audit 9)
    for (const rounds of ['x', [null], [{ setId: 'questions' }]]) {
      const notes: string[] = [];
      expect(restoreSnapshot({ ...snapshot(), rounds }, notes).rounds).toEqual([]);
      expect(notes).toEqual([expect.stringMatching(/overall ranking/)]);
    }
    expect(() => restoreSnapshot({ ...snapshot(), sessions: [] })).toThrow(/sessions/);
    expect(() => restoreSnapshot(null)).toThrow();
  });
});

describe('loadGame', () => {
  it('starts fresh without a snapshot', () => {
    const g = loadGame(dir, questions, listed, 0);
    expect(g.quiz.state.phase).toBe('lobby');
    expect(g.joiningOpen).toBe(false); // the host opens joining when it's time
    expect(g.warning).toBeUndefined();
  });

  it('restores a saved game', () => {
    const quiz = { ...initialQuizState(), phase: 'question' as const, index: 1, questionId: 'q2' };
    const s = snapshot({ quiz });
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(s));
    const g = loadGame(dir, questions, listed, 0);
    expect(g.quiz.state.index).toBe(1);
    expect(g.joiningOpen).toBe(true);
    expect(g.warning).toBeUndefined();
  });

  const sid = newId();
  const player = { id: 'g001', name: 'Ann', score: 900, correctCount: 1, correctTimeMs: 1 };
  /** A saved game in the middle of question 2, with one bound guest. */
  const midGame = (extra: Partial<Snapshot> = {}) =>
    snapshot({
      quiz: {
        ...initialQuizState(),
        phase: 'question',
        index: 1,
        questionId: 'q2',
        players: { g001: player },
      },
      sessions: { [sid]: { boundAt: 1, guestId: 'g001' } },
      ...extra,
    });

  it.each([
    ['broken JSON', '{"version":2,'],
    ['an old version', JSON.stringify({ ...snapshot(), version: 1 })],
    ['invalid data', JSON.stringify({ ...snapshot(), sessions: [] })],
  ])('keeps a snapshot with %s aside and starts fresh with a warning', (_what, text) => {
    writeFileSync(join(dir, SNAPSHOT_FILE), text);
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.phase).toBe('lobby');
    expect(g.warning).toMatch(/could not be restored.*kept as/);
    // removed once kept, so the next save can't copy it over a good previous save
    expect(readdirSync(dir)).toEqual(['snapshot.rejected-42.json']);
    expect(readFileSync(join(dir, 'snapshot.rejected-42.json'), 'utf8')).toBe(text);
  });

  it('falls back to the previous save when the last one is broken', () => {
    const prev = midGame();
    writeFileSync(join(dir, SNAPSHOT_FILE), '{"broken');
    writeFileSync(join(dir, SNAPSHOT_PREV_FILE), JSON.stringify(prev));
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.index).toBe(1);
    expect(g.joiningOpen).toBe(true);
    expect(g.sessions.guestOf(sid)).toBe('g001');
    expect(g.warning).toMatch(/save before it was restored/);
    expect(readdirSync(dir).sort()).toEqual([SNAPSHOT_PREV_FILE, 'snapshot.rejected-42.json']);
  });

  it('keeps both broken files aside when the previous save is broken too', () => {
    writeFileSync(join(dir, SNAPSHOT_FILE), '{"broken');
    writeFileSync(join(dir, SNAPSHOT_PREV_FILE), '{"also broken');
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.phase).toBe('lobby');
    expect(readdirSync(dir)).toContain('snapshot.rejected-42-prev.json');
  });

  it('changed questions restart only the quiz: players, sessions, collect and switch stay', () => {
    const s = midGame({
      collect: { ...initialCollectState(), bands: { K7P2: 'g001' } },
    });
    s.quiz.questionId = 'removed';
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(s));
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.phase).toBe('lobby');
    expect(g.quiz.state.players.g001).toMatchObject({ name: 'Ann Example', score: 0 });
    expect(g.sessions.guestOf(sid)).toBe('g001');
    expect(g.collect.state.bands).toEqual({ K7P2: 'g001' });
    expect(g.joiningOpen).toBe(true);
    expect(g.warning).toMatch(/restarted from the lobby.*kept as/);
    // the scores are still in the copy
    const kept = readFileSync(join(dir, 'snapshot.rejected-42-quiz.json'), 'utf8');
    expect((JSON.parse(kept) as Snapshot).quiz.players.g001?.score).toBe(900);
  });

  it('restores the previous save when snapshot.json is missing (crash at the wrong moment)', () => {
    const prev = midGame();
    writeFileSync(join(dir, SNAPSHOT_PREV_FILE), JSON.stringify(prev));
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.index).toBe(1);
    expect(g.warning).toMatch(/was missing, so the save before it was restored/);
    expect(g.mainIsGood).toBe(false);
  });

  it('the first save never copies a broken snapshot.json over a good previous save', async () => {
    const prev = JSON.stringify(midGame());
    writeFileSync(join(dir, SNAPSHOT_FILE), '{"broken');
    writeFileSync(join(dir, SNAPSHOT_PREV_FILE), prev);
    // as if the broken file couldn't be set aside: it is still there
    const w = new SnapshotWriter(
      dir,
      () => snapshot(),
      () => {},
      false,
    );
    w.saveNow();
    await w.flush();
    expect(readFileSync(join(dir, SNAPSHOT_PREV_FILE), 'utf8')).toBe(prev);
    w.saveNow(); // from now on snapshot.json is our own good save and is backed up
    await w.flush();
    expect(readFileSync(join(dir, SNAPSHOT_PREV_FILE), 'utf8')).not.toBe(prev);
  });

  it('keeps host-added guests', () => {
    const extra: Guest = { id: 'added-1', name: 'Cid New', country: 'DE', side: 'groom' };
    writeFileSync(
      join(dir, SNAPSHOT_FILE),
      JSON.stringify(midGame({ addedGuests: { 'added-1': extra } })),
    );
    const g = loadGame(dir, questions, listed, 42);
    expect(g.guests.get('added-1')).toEqual(extra);
    expect(g.guests.isAdded('added-1')).toBe(true);
    expect(g.collect.guests['added-1']).toEqual(extra); // collect mode sees them too
    expect(g.warning).toBeUndefined();
  });

  it('in the waiting room, players without a name on any device are removed (ghosts)', () => {
    // Damian's case: a guest from the example list joined, then the real guests.json came
    const lobby = snapshot({
      quiz: { ...initialQuizState(), players: { g001: player, g002: { ...player, id: 'g002' } } },
      sessions: { [sid]: { boundAt: 1, guestId: 'g002' } },
    });
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(lobby));
    const g = loadGame(dir, questions, [listed[1]!], 42); // g001 no longer on the list
    expect(Object.keys(g.quiz.state.players)).toEqual(['g002']);
    expect(g.notes.join(' ')).toMatch(/1 player\(s\) without a name/);
    // during a game the scores stay (the guest may come back on another device)
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(midGame()));
    const mid = loadGame(dir, questions, [listed[1]!], 43);
    expect(mid.quiz.state.players.g001?.score).toBe(900);
  });

  it('a changed guest list drops sessions and bands of removed guests, with a warning', () => {
    const s = midGame({
      collect: { ...initialCollectState(), bands: { K7P2: 'g001', AB12: 'g002' } },
    });
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(s));
    const g = loadGame(dir, questions, [listed[1]!], 42); // g001 removed from guests.json
    expect(g.sessions.guestOf(sid)).toBeNull();
    expect(g.collect.state.bands).toEqual({ AB12: 'g002' });
    expect(g.quiz.state.players.g001?.score).toBe(900); // the score stays in the quiz
    expect(g.warning).toMatch(
      /The old file is kept as .*-guests\.json\. Guest list: 1 device.*K7P2/,
    );
    // the save from before is kept, with the names and bands that were dropped
    const kept = readFileSync(join(dir, 'snapshot.rejected-42-guests.json'), 'utf8');
    expect((JSON.parse(kept) as Snapshot).collect.bands.K7P2).toBe('g001');
  });

  it('with the example list (guests.json missing), names and wristbands are kept', () => {
    const s = midGame({ collect: { ...initialCollectState(), bands: { K7P2: 'g001' } } });
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(s));
    const g = loadGame(dir, questions, [], 42, true);
    expect(g.sessions.guestOf(sid)).toBe('g001');
    expect(g.collect.state.bands).toEqual({ K7P2: 'g001' });
    // a setup note, not a problem: the host panel keeps it out of the warnings
    expect(g.warning).toBeUndefined();
    expect(g.notes.join(' ')).toMatch(/kept \(for when guests.json is back\)/);
  });

  it('player names follow corrected spellings in guests.json', () => {
    writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(midGame()));
    const fixed = [{ ...listed[0]!, name: 'Anna Example' }, listed[1]!];
    expect(loadGame(dir, questions, fixed, 42).quiz.state.players.g001?.name).toBe('Anna Example');
  });

  it('an invalid added guest is skipped with a warning, the rest of the game is kept', () => {
    const bad: Guest = { id: 'added-1', name: 'X', country: 'DE', side: 'groom' };
    writeFileSync(
      join(dir, SNAPSHOT_FILE),
      JSON.stringify(midGame({ addedGuests: { 'added-1': bad } })),
    );
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.index).toBe(1);
    expect(g.guests.get('added-1')).toBeUndefined();
    expect(g.warning).toMatch(/Added guest\(s\) added-1 were skipped/);
  });

  it("never crashes when a bad file can't be kept aside", () => {
    writeFileSync(join(dir, SNAPSHOT_FILE), '{"broken');
    mkdirSync(join(dir, 'snapshot.rejected-42.json')); // makes the copy fail
    const g = loadGame(dir, questions, listed, 42);
    expect(g.quiz.state.phase).toBe('lobby');
    expect(g.warning).toMatch(/could not be kept/);
  });

  it('still refuses invalid questions', () => {
    expect(() => loadGame(dir, [q('same'), q('same')], listed, 0)).toThrow(/Invalid questions/);
  });
});

describe('SnapshotWriter', () => {
  it('writes the latest data atomically and keeps the previous file', async () => {
    let n = 0;
    const errors: unknown[] = [];
    const w = new SnapshotWriter(
      join(dir, 'data'),
      () => snapshot({ savedAt: ++n }),
      (e) => errors.push(e),
    );
    w.saveNow();
    await w.flush();
    w.saveNow();
    await w.flush();
    const file = join(dir, 'data', SNAPSHOT_FILE);
    expect((JSON.parse(readFileSync(file, 'utf8')) as Snapshot).savedAt).toBe(2);
    const prev = readFileSync(join(dir, 'data', 'snapshot.prev.json'), 'utf8');
    expect((JSON.parse(prev) as Snapshot).savedAt).toBe(1);
    expect(readdirSync(join(dir, 'data')).sort()).toEqual([SNAPSHOT_FILE, 'snapshot.prev.json']);
    expect(errors).toEqual([]);
  });

  it('merges saves that come in while one is waiting to be written', async () => {
    let writes = 0;
    const w = new SnapshotWriter(
      dir,
      () => (writes++, snapshot()),
      () => {},
    );
    for (let i = 0; i < 100; i++) w.saveNow();
    await w.flush();
    expect(writes).toBe(1);
  });

  it('flush writes a pending debounced save', async () => {
    const w = new SnapshotWriter(
      dir,
      () => snapshot(),
      () => {},
    );
    w.saveSoon();
    await w.flush();
    expect(readdirSync(dir)).toContain(SNAPSHOT_FILE);
  });
});
