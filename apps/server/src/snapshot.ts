// Saves and restores the whole game (quiz, collect mode, guest sessions, joining switch) to one file.
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Collect, restoreCollectState, type CollectState, type Guest } from './game/collect';
import { SNAPSHOT_DEBOUNCE_MS } from './game/config';
import { MAIN_SET, SET_ID, type RoundResult } from '@idoknow/shared';
import { cleanRecord, isNum } from './game/safe';
import { Quiz, restoreQuizState, type Question, type QuizState } from './game/quiz';
import { GuestBook, restoreAddedGuests } from './guests';
import { restoreSessions, SessionStore, type Sessions } from './sessions';

/**
 * Version 3 (Phase 6.7): the joining switch instead of a random join token. Version 2 files
 * still load (their join token is ignored; joining starts closed).
 */
export const SNAPSHOT_VERSION = 3;
export const SNAPSHOT_FILE = 'snapshot.json';
export const SNAPSHOT_PREV_FILE = 'snapshot.prev.json';

/** Plain JSON. SECRET: holds correct answers and everyone's picks. */
export interface Snapshot {
  version: typeof SNAPSHOT_VERSION;
  savedAt: number;
  quiz: QuizState;
  collect: CollectState;
  sessions: Sessions;
  /** Guests the host added at the party (never written to guests.json). */
  addedGuests: Record<string, Guest>;
  /** New guests may pick a name (the host's switch). */
  joiningOpen: boolean;
  /** The host's auto-reveal switch (Phase 6.9; missing in older files = on). */
  autoReveal?: boolean;
  /** The host's reading-time switch (Phase 9.5; missing in older files = on). */
  readingStep?: boolean;
  /** The question list the real quiz plays (Phase 6.10; missing = the main quiz). */
  activeSet?: string;
  /** Rounds played to the end, for the overall ranking (Phase 6.10). */
  rounds?: RoundResult[];
}

/** Checks a snapshot read from disk; throws if it isn't valid (broken, or from an older version). */
export function restoreSnapshot(raw: unknown, notes: string[] = []): Snapshot {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid snapshot: not an object');
  const r = raw as Record<string, unknown>;
  if (r.version !== SNAPSHOT_VERSION && r.version !== 2)
    throw new Error(`Invalid snapshot: version ${String(r.version)}`);
  if (!isNum(r.savedAt)) throw new Error('Invalid snapshot: savedAt');
  if (r.version === SNAPSHOT_VERSION && typeof r.joiningOpen !== 'boolean') {
    throw new Error('Invalid snapshot: joiningOpen');
  }
  const skipped: string[] = [];
  const snap: Snapshot = {
    version: SNAPSHOT_VERSION,
    savedAt: r.savedAt,
    quiz: restoreQuizState(r.quiz),
    collect: restoreCollectState(r.collect),
    sessions: restoreSessions(r.sessions),
    addedGuests: restoreAddedGuests(r.addedGuests, skipped),
    joiningOpen: r.joiningOpen === true,
    ...(typeof r.autoReveal === 'boolean' ? { autoReveal: r.autoReveal } : {}),
    ...(typeof r.readingStep === 'boolean' ? { readingStep: r.readingStep } : {}),
    ...(r.activeSet === MAIN_SET || (typeof r.activeSet === 'string' && SET_ID.test(r.activeSet))
      ? { activeSet: r.activeSet }
      : {}),
    ...(r.rounds !== undefined ? { rounds: roundsOrNone(r.rounds, notes) } : {}),
  };
  if (skipped.length) {
    notes.push(
      `Added guest(s) ${skipped.join(', ')} were skipped: they don't pass today's checks.`,
    );
  }
  return snap;
}

export interface LoadedGame {
  quiz: Quiz;
  collect: Collect;
  guests: GuestBook;
  sessions: SessionStore;
  joiningOpen: boolean;
  autoReveal: boolean;
  readingStep: boolean;
  /** The list the real quiz plays (a set that no longer exists falls back to the main quiz). */
  activeSet: string;
  rounds: RoundResult[];
  /** Set when the saved game couldn't be fully restored; the host panel shows it. */
  warning?: string;
  /** Setup notes (not problems) for the log and the host's "Setup" line. */
  notes: string[];
  /**
   * snapshot.json is a good save. When false, the first save must not copy it over
   * snapshot.prev.json (it may be the broken file, and prev the only good copy).
   */
  mainIsGood: boolean;
}

type Read =
  { ok: true; snap: Snapshot; notes: string[] } | { ok: false; reason: string } | { ok: 'missing' };

function readSnapshot(file: string): Read {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: 'missing' };
    return { ok: false, reason: (e as Error).message };
  }
  try {
    const notes: string[] = [];
    return { ok: true, snap: restoreSnapshot(JSON.parse(text), notes), notes };
  } catch (e) {
    return { ok: false, reason: (e as Error).message.split('\n')[0] ?? 'unknown' };
  }
}

/**
 * Moves a snapshot that can't be used to snapshot.rejected-<time><suffix>.json (copy, then
 * remove the original). Never throws: returns a sentence for the warning.
 */
function setAside(file: string, dataDir: string, now: number, suffix = ''): string {
  const kept = join(dataDir, `snapshot.rejected-${now}${suffix}.json`);
  try {
    copyFileSync(file, kept);
  } catch (e) {
    return `${file} could not be kept (${(e as Error).message}).`;
  }
  try {
    rmSync(file, { force: true, maxRetries: 5 });
  } catch (e) {
    return `${file} is kept as ${kept} but could not be removed (${(e as Error).message}).`;
  }
  return `The old file is kept as ${kept}.`;
}

/** Copies a file aside without removing it. Never throws. */
function copyAside(file: string, dataDir: string, now: number, suffix: string): string {
  const kept = join(dataDir, `snapshot.rejected-${now}${suffix}.json`);
  try {
    copyFileSync(file, kept);
    return `The old file is kept as ${kept}.`;
  } catch (e) {
    return `The old file could not be kept (${(e as Error).message}).`;
  }
}

/**
 * Startup only. Restores the game from data/snapshot.json, or starts a fresh one.
 * - A broken snapshot.json (bad JSON, old version, invalid data) is set aside as
 *   snapshot.rejected-<time>.json, and snapshot.prev.json (the save before it) is tried.
 *   A missing snapshot.json next to a good snapshot.prev.json (a crash at the wrong moment)
 *   also restores the previous save. To reset the game completely, delete the whole data folder.
 * - If only the quiz no longer fits questions.json (questions were changed), the quiz starts
 *   again from the lobby with the same players, and everything else (guest sessions, collect
 *   mode, the join link) is kept.
 * Every problem ends in a warning for the host, never in a crash. Throws only for invalid
 * questions (those can never start).
 */
export function loadGame(
  dataDir: string,
  /** The main quiz's questions, or a lookup by list (Phase 6.10: the saved set is played on). */
  questions: readonly Question[] | ((list: string) => readonly Question[] | undefined),
  /** The guest list from guests.json. */
  listed: readonly Guest[],
  now: number,
  /** The example list is in use because guests.json is missing. */
  listIsExample = false,
  /** The countdown of every question. */
  timeLimitSec?: number,
): LoadedGame {
  const pick = typeof questions === 'function' ? questions : () => questions;
  let active = MAIN_SET;
  const newQuiz = (state?: QuizState) =>
    new Quiz(pick(active) ?? pick(MAIN_SET) ?? [], state, false, timeLimitSec);
  const file = join(dataDir, SNAPSHOT_FILE);
  const prevFile = join(dataDir, SNAPSHOT_PREV_FILE);
  const main = readSnapshot(file);
  if (main.ok === true)
    return fromSnapshot(main.snap, file, main.notes.join(' ') || undefined, true);

  const prev = readSnapshot(prevFile);
  if (main.ok === 'missing' && prev.ok === 'missing') {
    return { ...fresh(newQuiz(), listed), mainIsGood: false };
  }
  const notes: string[] = [];
  if (main.ok === false) notes.push(setAside(file, dataDir, now));
  const problem =
    main.ok === 'missing'
      ? `${SNAPSHOT_FILE} was missing`
      : `the last save was broken (${main.reason})`;
  if (prev.ok === true) {
    const restored = `${problem}, so the save before it was restored (from ${new Date(prev.snap.savedAt).toISOString()}).`;
    return fromSnapshot(prev.snap, prevFile, [restored, ...notes, ...prev.notes].join(' '), false);
  }
  if (prev.ok === false) notes.push(setAside(prevFile, dataDir, now, '-prev'));
  const reasons = [problem, prev.ok === false ? `the save before it too (${prev.reason})` : '']
    .filter(Boolean)
    .join('; ');
  return {
    ...fresh(newQuiz(), listed),
    mainIsGood: false,
    warning: `The saved game could not be restored (${reasons}). A new game was started. ${notes.join(' ')}`,
  };

  function fromSnapshot(
    snap: Snapshot,
    source: string,
    warning: string | undefined,
    mainIsGood: boolean,
  ): LoadedGame {
    const setNotes: string[] = [];
    if (snap.activeSet && snap.activeSet !== MAIN_SET) {
      if (pick(snap.activeSet)) active = snap.activeSet;
      else setNotes.push('The question set of the saved round is gone: the main quiz is back.');
    }
    let quiz: Quiz;
    try {
      quiz = newQuiz(snap.quiz);
    } catch (e) {
      // questions.json changed: the saved position no longer fits
      quiz = newQuiz();
      for (const p of Object.values(snap.quiz.players)) quiz.addPlayer(p.id, p.name);
      const reason = (e as Error).message.split('\n')[0];
      warning = [
        warning,
        `The quiz no longer fits questions.json (${reason}), so it restarted from the lobby with the same players and scores at 0. Guest sessions, collect mode and the joining switch were kept. ${copyAside(source, dataDir, now, '-quiz')}`,
      ]
        .filter(Boolean)
        .join(' ');
    }
    const guests = new GuestBook(listed, snap.addedGuests);
    const sessions = new SessionStore(snap.sessions);
    const notes: string[] = [];
    const setup: string[] = [];
    if (listIsExample) {
      // don't drop anything because of a missing guests.json: names and bands come back with it
      if (Object.keys(snap.sessions).length || Object.keys(snap.collect.bands).length) {
        setup.push(
          'Guest list: the names and wristbands picked so far are kept (for when guests.json is back).',
        );
      }
    } else {
      // guests.json may have changed since the save: forget names and bands of removed guests
      const exists = (id: string) => guests.get(id) !== undefined;
      const lostSessions = Object.values(snap.sessions).filter((x) => !exists(x.guestId)).length;
      const lostBands = Object.entries(snap.collect.bands).filter(([, id]) => !exists(id));
      if (lostSessions || lostBands.length) {
        notes.push(copyAside(source, dataDir, now, '-guests'));
        sessions.dropUnknown(exists);
        if (lostSessions) {
          notes.push(
            `Guest list: ${lostSessions} device(s) had a name that is no longer on the list.`,
          );
        }
        for (const [code] of lostBands) delete snap.collect.bands[code];
        if (lostBands.length) {
          notes.push(
            `Guest list: wristband(s) ${lostBands.map(([code]) => code).join(', ')} belonged to guests no longer on the list.`,
          );
        }
      }
      // a spelling corrected in guests.json shows up on the leaderboard too
      for (const p of Object.values(quiz.state.players)) {
        const g = guests.get(p.id);
        if (g && g.name !== p.name) p.name = g.name;
      }
    }
    // In the waiting room the players are exactly the guests with a name: a player left over
    // from a name that went away (a changed guest list, a name released during an earlier game)
    // would be counted as "joined" and play on under nobody's phone.
    if (quiz.state.phase === 'lobby') {
      const ghosts = Object.keys(quiz.state.players).filter((id) => !sessions.isTaken(id));
      for (const id of ghosts) quiz.removePlayer(id);
      if (ghosts.length) {
        setup.push(
          `Waiting room: ${ghosts.length} player(s) without a name on any device were removed.`,
        );
      }
    }
    if (notes.length || setNotes.length) {
      warning = [warning, ...setNotes, ...notes].filter(Boolean).join(' ');
    }
    return {
      quiz,
      collect: new Collect(guests.all, snap.collect),
      guests,
      sessions,
      joiningOpen: snap.joiningOpen,
      autoReveal: snap.autoReveal ?? true,
      readingStep: snap.readingStep ?? true,
      activeSet: active,
      rounds: snap.rounds ?? [],
      mainIsGood,
      notes: setup,
      ...(warning ? { warning } : {}),
    };
  }
}

function fresh(quiz: Quiz, listed: readonly Guest[]) {
  const guests = new GuestBook(listed);
  return {
    quiz,
    collect: new Collect(guests.all),
    guests,
    sessions: new SessionStore(),
    joiningOpen: false,
    autoReveal: true,
    readingStep: true,
    activeSet: MAIN_SET,
    rounds: [],
    notes: [],
  };
}

/** Rounds read from a snapshot; throws if they aren't valid. */
/** Broken rounds only cost the overall ranking, never the saved game (audit 9). */
function roundsOrNone(raw: unknown, notes: string[]): RoundResult[] {
  try {
    return restoreRounds(raw);
  } catch {
    notes.push('The saved rounds of the overall ranking were unreadable: it starts again.');
    return [];
  }
}

function restoreRounds(raw: unknown): RoundResult[] {
  if (!Array.isArray(raw)) throw new Error('Invalid snapshot: rounds');
  return raw.map((r: unknown, i) => {
    const x = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    if (typeof x.setId !== 'string' || typeof x.setName !== 'string' || !isNum(x.finishedAt)) {
      throw new Error(`Invalid snapshot: rounds ${i}`);
    }
    return {
      setId: x.setId,
      setName: x.setName,
      finishedAt: x.finishedAt,
      players: cleanRecord<RoundResult['players'][string]>(
        x.players,
        (v) => {
          const p = v as Partial<RoundResult['players'][string]>;
          return (
            typeof p === 'object' &&
            p !== null &&
            typeof p.name === 'string' &&
            isNum(p.score) &&
            isNum(p.correctCount)
          );
        },
        `rounds ${i} players`,
      ),
    };
  });
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Replaces a file; retries briefly because on Windows a virus scanner may hold it open. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !RETRY_CODES.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/**
 * Writes snapshots one at a time, atomically (temp file + rename), keeping the previous file
 * as snapshot.prev.json. The data is read when the write starts, so it is always the latest.
 */
export class SnapshotWriter {
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  /** A write is queued and hasn't started: another saveNow() can join it. */
  private queued = false;
  /** Copy the current snapshot.json to snapshot.prev.json before replacing it. */
  private backup: boolean;
  /** `savedAt` of the last snapshot written (the host panel shows "saved 3 s ago"). */
  lastSavedAt: number | null = null;
  /** The last write failed (the host panel warns). */
  failing = false;
  /** Called after every write, good or failed (the host panel's "saved N s ago" and warning). */
  onWritten?: () => void;

  constructor(
    private readonly dataDir: string,
    private readonly data: () => Snapshot,
    private readonly onError: (e: unknown) => void,
    /** False when snapshot.json at startup isn't a good save (see LoadedGame.mainIsGood). */
    backupFirst = true,
  ) {
    this.backup = backupFirst;
  }

  /** Save as soon as the previous write is done. */
  saveNow(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    // a queued write reads the data when it starts, so it will include this change too
    if (this.queued) return;
    this.queued = true;
    this.chain = this.chain
      .then(() => {
        this.queued = false;
        return this.write();
      })
      .then(
        () => {
          this.failing = false;
          this.onWritten?.();
        },
        (e: unknown) => {
          this.failing = true;
          this.onError(e);
          this.onWritten?.();
        },
      );
  }

  /** Save within SNAPSHOT_DEBOUNCE_MS (for frequent changes like answers). */
  saveSoon(): void {
    this.timer ??= setTimeout(() => this.saveNow(), SNAPSHOT_DEBOUNCE_MS);
  }

  /** Waits for all writes; a pending debounced save is written now. */
  async flush(): Promise<void> {
    if (this.timer) this.saveNow();
    await this.chain;
  }

  private async write(): Promise<void> {
    const file = join(this.dataDir, SNAPSHOT_FILE);
    const tmp = `${file}.tmp`;
    await mkdir(this.dataDir, { recursive: true });
    const handle = await open(tmp, 'w');
    const snapshot = this.data();
    try {
      await handle.writeFile(JSON.stringify(snapshot));
      await handle.sync(); // on disk before the rename, so a power cut can't leave a broken file
    } catch (e) {
      await handle.close().catch(() => {}); // keep the first error, not a close error
      throw e;
    }
    await handle.close();
    if (this.backup) {
      await copyFile(file, join(this.dataDir, SNAPSHOT_PREV_FILE)).catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // no previous file yet
      });
    }
    await renameWithRetry(tmp, file);
    this.backup = true; // snapshot.json is now our own good save
    this.lastSavedAt = snapshot.savedAt;
  }
}
