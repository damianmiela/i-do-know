// The game archive (Phase 6.8): every finished real game is saved as data/games/<id>.json, so the
// host can go through it later (who answered what, and when) and show it on the big screen.
// PRIVATE: the files hold guests' names and answers. They stay in data/ (git-ignored) and only
// ever reach the host (and the aggregated ranking or votes the big screen).
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  LANGS,
  TOP_COUNT,
  type ArchivedPlayer,
  type ArchivedQuestion,
  type GameRecord,
  type GameSummary,
  type PastOnScreen,
  type Side,
} from '@idoknow/shared';
import type { Quiz } from './game/quiz';
import { hostQuestions, type CountryOf } from './views';

/** A game id: the UTC date and time the game ended, e.g. 2026-09-12T21-15-03Z (-2 if taken). */
const GAME_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d{1,3})?$/;
export const isGameId = (v: unknown): v is string => typeof v === 'string' && GAME_ID.test(v);

/** The finished game as a record: the questions as played, every answer, the final ranking. */
export function gameRecord(
  quiz: Quiz,
  countryOf: CountryOf,
  timeLimitSec: number,
  now: number,
  /** The bride's and groom's role (Phase 9.5): they're kept apart when they played along. */
  roleOf: (id: string) => Side | undefined = () => undefined,
): Omit<GameRecord, 'id'> {
  const s = quiz.state;
  const names = new Map(Object.values(s.players).map((p) => [p.id, p.name]));
  const byId = new Map(hostQuestions(quiz.questions, timeLimitSec).map((q) => [q.id, q]));
  const questions: ArchivedQuestion[] = s.log.flatMap((entry) => {
    const q = byId.get(entry.questionId);
    if (!q) return [];
    return [
      {
        ...q,
        openedAt: entry.openedAt,
        skipped: entry.skipped,
        answers: Object.entries(entry.answers)
          .map(([playerId, a]) => ({
            playerId,
            name: names.get(playerId) ?? playerId,
            option: a.option,
            elapsedMs: a.elapsedMs,
            points: a.points,
          }))
          .sort((a, b) => a.elapsedMs - b.elapsedMs),
      },
    ];
  });
  const players: ArchivedPlayer[] = quiz.ranking().map((p) => {
    const country = countryOf(p.id);
    return {
      id: p.id,
      name: p.name,
      ...(country ? { country } : {}),
      rank: p.rank,
      score: p.score,
      correctCount: p.correctCount,
    };
  });
  // off the ranking, with the place they would have had
  const couple = quiz
    .ranking(true)
    .filter((p) => quiz.offBoard.has(p.id) && roleOf(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name,
      rank: p.rank,
      score: p.score,
      correctCount: p.correctCount,
      role: roleOf(p.id)!,
    }));
  return {
    version: 1,
    finishedAt: now,
    timeLimitSec,
    questions,
    players,
    ...(couple.length ? { couple } : {}),
  };
}

/** The file id for a game that ended at `now`. */
const idAt = (now: number) => `${new Date(now).toISOString().slice(0, 19).replace(/:/g, '-')}Z`;

/** Everyone on 1st place (no winner when nobody scored). */
const winnersOf = (g: GameRecord) =>
  g.players.filter((p) => p.rank === 1 && p.score > 0).map((p) => p.name);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * A record read from disk, checked enough to show it (the files are only written by us, but a
 * hand-edited or half-written one must not break the whole list: audit 9).
 */
function isRecord(raw: unknown): raw is GameRecord {
  const g = raw as Partial<GameRecord> | null;
  return (
    isObject(g) &&
    g.version === 1 &&
    typeof g.finishedAt === 'number' &&
    Array.isArray(g.questions) &&
    Array.isArray(g.players) &&
    g.players.every(
      (p: unknown) =>
        isObject(p) &&
        typeof p.id === 'string' &&
        typeof p.name === 'string' &&
        typeof p.rank === 'number' &&
        typeof p.score === 'number',
    ) &&
    g.questions.every(
      (q: unknown) =>
        isObject(q) &&
        isObject(q.text) &&
        Array.isArray(q.options) &&
        q.options.every(isObject) &&
        Array.isArray(q.answers) &&
        q.answers.every(
          (a: unknown) =>
            isObject(a) &&
            typeof a.playerId === 'string' &&
            typeof a.option === 'number' &&
            typeof a.elapsedMs === 'number',
        ),
    ) &&
    (g.couple === undefined ||
      (Array.isArray(g.couple) &&
        g.couple.every(
          (p: unknown) => isObject(p) && typeof p.id === 'string' && typeof p.name === 'string',
        )))
  );
}

/** data/games: one JSON file per finished game. Small files, host only: synchronous is fine. */
export class GameArchive {
  constructor(private readonly dir: string) {}

  /** Writes the game (temp file + fsync + rename). Returns its id. Throws if the disk fails. */
  save(game: Omit<GameRecord, 'id'>): string {
    mkdirSync(this.dir, { recursive: true });
    let id = idAt(game.finishedAt);
    for (let n = 2; existsSync(this.file(id)); n++) id = `${idAt(game.finishedAt)}-${n}`;
    const file = this.file(id);
    const tmp = `${file}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, `${JSON.stringify({ ...game, id })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    return id;
  }

  /** The saved games, newest first. Unreadable files are left out. */
  list(): GameSummary[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && isGameId(f.slice(0, -5)))
      .flatMap((f) => {
        const g = this.get(f.slice(0, -5));
        return g
          ? [
              {
                id: g.id,
                finishedAt: g.finishedAt,
                playerCount: g.players.length,
                questionCount: g.questions.length,
                winners: winnersOf(g),
                ...(g.setName ? { setName: g.setName } : {}),
              },
            ]
          : [];
      })
      .sort((a, b) => b.finishedAt - a.finishedAt || b.id.localeCompare(a.id));
  }

  /** One game, or undefined (unknown id, or a broken file). */
  get(id: string): GameRecord | undefined {
    if (!isGameId(id)) return undefined;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file(id), 'utf8'));
      return isRecord(raw) ? { ...raw, id } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Deletes a game. False if there is none with this id. */
  delete(id: string): boolean {
    if (!isGameId(id) || !existsSync(this.file(id))) return false;
    rmSync(this.file(id));
    return true;
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}

/** What the big screen shows of a past game: its top 10, or one question's votes. */
export function pastOnScreen(game: GameRecord, question?: number): PastOnScreen | undefined {
  const base = { id: game.id, finishedAt: game.finishedAt, questionCount: game.questions.length };
  if (question === undefined) {
    return {
      ...base,
      top: game.players.slice(0, TOP_COUNT).map((p) => ({
        rank: p.rank,
        name: p.name,
        score: p.score,
        ...(p.country ? { country: p.country } : {}),
      })),
    };
  }
  const q = game.questions[question];
  if (!q) return undefined;
  const optionCounts = q.options.map(() => 0);
  for (const a of q.answers) optionCounts[a.option] = (optionCounts[a.option] ?? 0) + 1;
  return {
    ...base,
    question,
    votes: {
      question: {
        id: q.id,
        kind: q.kind,
        text: q.text,
        options: q.options,
        timeLimitSec: q.timeLimitSec,
        ...(q.photo ? { photo: q.photo } : {}),
      },
      optionCounts,
      correctOption: q.correct,
    },
  };
}

/**
 * One CSV row per question and player (answered or not), for a spreadsheet. Texts in English
 * (else the first language filled). Cells a spreadsheet would run as a formula are defused.
 */
export function gameCsv(game: GameRecord): string {
  const text = (t: Record<string, string>) =>
    t.en?.trim() || LANGS.map((l) => t[l]).find(Boolean) || '';
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // =HYPERLINK(...) in a name must stay text
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: (string | number)[][] = [
    ['question', 'text', 'player', 'answer', 'correct', 'seconds', 'points', 'skipped'],
  ];
  game.questions.forEach((q, i) => {
    const answered = new Map(q.answers.map((a) => [a.playerId, a]));
    // the couple too, when they played along (their rows after everyone's)
    for (const p of [...game.players, ...(game.couple ?? [])]) {
      const a = answered.get(p.id);
      rows.push([
        i + 1,
        text(q.text),
        p.name,
        a ? text(q.options[a.option] ?? {}) : '',
        a ? (a.option === q.correct ? 'yes' : 'no') : '',
        a ? (a.elapsedMs / 1000).toFixed(1) : '',
        a ? a.points : 0,
        q.skipped ? 'yes' : '',
      ]);
    }
  });
  // a BOM so Excel reads the accents (ł, ñ, ß) as UTF-8
  return `\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
