// Loads the content files. Runs at startup only: every problem here stops the server.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Guest } from './game/collect';
import {
  isTimerSec,
  LANGS,
  SET_ID,
  TIMER_DEFAULT_SEC,
  TIMER_MAX_SEC,
  TIMER_MIN_SEC,
  type EventInfo,
  type Localized,
} from '@idoknow/shared';
import { setName, type QuestionSet } from './questionStore';
import { tidyQuestions, validateQuestions, type Question } from './game/quiz';
import { sameNameWarnings, validateGuests } from './guests';

interface Loaded<T> {
  items: T[];
  /** questions.json only: the warm-up questions (optional `warmup` list). */
  warmup?: T[];
  /** The example file is used because the real one doesn't exist yet. */
  isExample: boolean;
  /** Problems for the host panel (e.g. two guests with the same name). */
  warnings: string[];
  /** Setup notes (e.g. the example file is in use): the log and the host's "Setup" line. */
  notes: string[];
  /** The raw file's top level (questions.json keeps the timer there). */
  raw: Record<string, unknown> | null;
}

/** The id of a raw list item, if it has a string one. */
const idOf = (item: unknown): string | undefined => {
  const id = (item as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : undefined;
};

/**
 * Reads content/<name>.json, or <name>.example.json if the real file doesn't exist yet. Returns
 * the file's top-level object (null if it isn't one).
 */
function readContent(
  contentDir: string,
  name: string,
): { file: string; top: Record<string, unknown> | null; isExample: boolean } {
  let file = join(contentDir, `${name}.json`);
  let isExample = false;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    file = join(contentDir, `${name}.example.json`);
    isExample = true;
    text = readFileSync(file, 'utf8');
  }
  // Windows PowerShell 5.1 saves UTF-8 with a byte order mark, which JSON.parse refuses
  text = text.replace(/^\uFEFF/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  const top =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  return { file, top, isExample };
}

/**
 * Reads content/<name>.json (or the example file) and returns its `key` array after `validate`
 * found no problems.
 */
function loadList<T>(
  contentDir: string,
  name: string,
  key: string,
  validate: (items: unknown) => string[],
  /** Tidies a list before it's checked (questions: missing languages become ''). */
  normalize: (items: unknown) => unknown = (items) => items,
): Loaded<T> {
  const { file, top, isExample } = readContent(contentDir, name);
  const warning = isExample
    ? `content/${name}.json is missing: the EXAMPLE ${name} are in use`
    : undefined;
  const items = normalize(top?.[key]);
  const errors = validate(items);
  // questions.json may also have a "warmup" list (practice round), checked the same way
  const warmup = key === 'questions' ? normalize(top?.warmup) : undefined;
  if (warmup !== undefined) {
    errors.push(...validate(warmup).map((e) => `warmup ${e}`));
    // a late tap from the warm-up must never match a real question (answers carry the id)
    const ids = new Set(Array.isArray(items) ? items.map(idOf) : []);
    if (Array.isArray(warmup)) {
      for (const id of warmup.map(idOf)) {
        if (id !== undefined && ids.has(id)) errors.push(`warmup id "${id}" is also a question id`);
      }
    }
  }
  if (errors.length) throw new Error(`${file} has problems:\n- ${errors.join('\n- ')}`);
  return {
    items: items as T[],
    ...(warmup !== undefined ? { warmup: warmup as T[] } : {}),
    isExample: warning !== undefined,
    warnings: [],
    notes: warning ? [warning] : [],
    raw: top,
  };
}

/**
 * The extra question sets (optional `sets` of questions.json, Phase 6.10): each with a valid id
 * and name, its questions checked like the main ones, and no question id used twice anywhere
 * (a late tap must never count for a question of another list).
 */
function loadSets(raw: unknown, taken: Set<string>): QuestionSet[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('content/questions.json: "sets" must be a list');
  const errors: string[] = [];
  const ids = new Set<string>();
  const sets = raw.map((entry: unknown, i): QuestionSet => {
    const s = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const at = `set ${i + 1}`;
    const id = typeof s.id === 'string' && SET_ID.test(s.id) && !ids.has(s.id) ? s.id : undefined;
    if (!id) errors.push(`${at}: id missing, invalid or used twice (like set-ab12)`);
    else ids.add(id);
    const name = setName(s.name);
    if (!name) errors.push(`${at}: name missing or too long`);
    const questions = tidyQuestions(s.questions);
    errors.push(...validateQuestions(questions).map((e) => `${at} ${e}`));
    for (const q of Array.isArray(questions) ? (questions as { id?: unknown }[]) : []) {
      if (typeof q.id !== 'string') continue;
      if (taken.has(q.id)) errors.push(`${at}: question id "${q.id}" is used twice`);
      taken.add(q.id);
    }
    return {
      id: id ?? '',
      name: name ?? '',
      questions: questions as Question[],
      ...(s.couple === true ? { couple: true } : {}),
    };
  });
  if (errors.length) {
    throw new Error(`content/questions.json has problems:\n- ${errors.join('\n- ')}`);
  }
  return sets;
}

/** content/questions.json (or the example file), with the countdown of every question. */
export function loadQuestions(
  contentDir: string,
): Loaded<Question> & { timeLimitSec: number; sets: QuestionSet[]; couple: boolean } {
  const loaded = loadList<Question>(
    contentDir,
    'questions',
    'questions',
    validateQuestions,
    tidyQuestions,
  );
  const sec = loaded.raw?.timeLimitSec;
  if (sec !== undefined && !isTimerSec(sec)) {
    throw new Error(
      `content/questions.json: timeLimitSec must be a whole number from ${TIMER_MIN_SEC} to ${TIMER_MAX_SEC}`,
    );
  }
  const taken = new Set([...loaded.items, ...(loaded.warmup ?? [])].map((q) => q.id));
  const sets = loadSets(loaded.raw?.sets, taken);
  // the main quiz's "the couple plays along" (Phase 9.5)
  const couple = loaded.raw?.couple === true;
  return { ...loaded, timeLimitSec: sec ?? TIMER_DEFAULT_SEC, sets, couple };
}

/** Longest event title per language and side name (the lobby title must fit the big screen). */
export const EVENT_TITLE_MAX = 80;
export const SIDE_NAME_MAX = 40;

/** Problems in event.json's contents (empty: fine). */
export function eventProblems(top: Record<string, unknown> | null): string[] {
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() !== '' && v.length <= max;
  const title = top?.title as Record<string, unknown> | undefined;
  const sides = top?.sides as Record<string, unknown> | undefined;
  return [
    ...LANGS.filter((l) => !text(title?.[l], EVENT_TITLE_MAX)).map(
      (l) => `title.${l} must be a text of 1 to ${EVENT_TITLE_MAX} characters`,
    ),
    ...(['bride', 'groom'] as const)
      .filter((s) => !text(sides?.[s], SIDE_NAME_MAX))
      .map((s) => `sides.${s} must be a text of 1 to ${SIDE_NAME_MAX} characters`),
  ];
}

/** content/event.json (or the example file): the quiz title and the names of the two sides. */
export function loadEvent(contentDir: string): { event: EventInfo; notes: string[] } {
  const { file, top, isExample } = readContent(contentDir, 'event');
  const errors = eventProblems(top);
  if (errors.length) throw new Error(`${file} has problems:\n- ${errors.join('\n- ')}`);
  const title = top!.title as Localized;
  const sides = top!.sides as EventInfo['sides'];
  return {
    // only the known fields: nothing else from the file ever reaches a client
    event: {
      title: Object.fromEntries(LANGS.map((l) => [l, title[l]])) as Localized,
      sides: { bride: sides.bride, groom: sides.groom },
    },
    notes: isExample ? ['content/event.json is missing: the EXAMPLE couple is in use'] : [],
  };
}

/** content/guests.json (or the example file). Personal data: never logged or sent in full. */
export function loadGuests(contentDir: string): Loaded<Guest> {
  const loaded = loadList<Guest>(contentDir, 'guests', 'guests', validateGuests);
  // one way of writing accents (a file saved on a Mac may hold "ü" as "u" + a separate mark),
  // so names look, search and compare the same everywhere (Phase 9)
  const items = loaded.items.map((g) => ({ ...g, name: g.name.normalize('NFC') }));
  return { ...loaded, items, warnings: [...loaded.warnings, ...sameNameWarnings(items)] };
}
