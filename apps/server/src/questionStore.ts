// The question editor's storage (Phase 6.6): applies one edit to the question lists and writes
// content/questions.json. Private content: the file is git-ignored and only ever written here.
import { copyFile, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LANGS,
  MAIN_SET,
  SET_ID,
  SET_NAME_MAX,
  WARMUP_LIST,
  foldText,
  questionProblems,
  type EditedQuestion,
  type Localized,
  type QuestionList,
} from '@idoknow/shared';
import { newId } from './auth';
import { HIDDEN_CHARS } from './guests';
import { isSafeKey } from './game/safe';
import type { Question } from './game/quiz';
import { renameWithRetry } from './snapshot';

/** An extra list of questions for another round (Phase 6.10). */
export interface QuestionSet {
  id: string;
  name: string;
  questions: Question[];
  /** The bride and groom answer too, off the leaderboard (Phase 9.5). */
  couple?: boolean;
}

export interface QuestionLists {
  questions: Question[];
  warmup: Question[];
  sets: QuestionSet[];
  /** The main quiz: the bride and groom answer too, off the leaderboard (Phase 9.5). */
  couple?: boolean;
}

/** Whether the couple plays along in this list's round (never in the warm-up). */
export function coupleIn(lists: QuestionLists, list: QuestionList): boolean {
  if (list === MAIN_SET) return lists.couple === true;
  return lists.sets.find((s) => s.id === list)?.couple === true;
}

/** Switches "the couple plays along" for the main quiz or a set (a copy of the lists). */
export function setCouple(lists: QuestionLists, list: unknown, on: boolean): SetResult {
  const next = copyLists(lists);
  if (list === MAIN_SET) {
    if (on) next.couple = true;
    else delete next.couple;
    return { ok: true, lists: next, id: MAIN_SET };
  }
  const set = next.sets.find((s) => s.id === list);
  if (!set) return { ok: false, error: 'unknown-set' }; // the warm-up too: it's only practice
  if (on) set.couple = true;
  else delete set.couple;
  return { ok: true, lists: next, id: set.id };
}

/** The display name of a list (the main quiz and the warm-up have fixed ones). */
export function listName(lists: QuestionLists, list: QuestionList): string {
  if (list === MAIN_SET) return 'Main quiz';
  if (list === WARMUP_LIST) return 'Warm-up';
  return lists.sets.find((s) => s.id === list)?.name ?? list;
}

/** The questions of a list, or undefined for an unknown one. */
export function listOf(lists: QuestionLists, list: unknown): Question[] | undefined {
  if (list === MAIN_SET) return lists.questions;
  if (list === WARMUP_LIST) return lists.warmup;
  return typeof list === 'string' && SET_ID.test(list)
    ? lists.sets.find((s) => s.id === list)?.questions
    : undefined;
}

/** A copy whose arrays can be changed without touching the original. */
const copyLists = (lists: QuestionLists): QuestionLists => ({
  questions: [...lists.questions],
  warmup: [...lists.warmup],
  sets: lists.sets.map((s) => ({ ...s, questions: [...s.questions] })),
  ...(lists.couple ? { couple: true } : {}),
});

/** A set name as typed by the host: trimmed, one line, not empty, not too long. */
export function setName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // like guest names: no invisible or direction-changing characters (audit 9)
  const name = raw.replace(new RegExp(HIDDEN_CHARS, 'gu'), '').replace(/\s+/g, ' ').trim();
  return name && name.length <= SET_NAME_MAX ? name : undefined;
}

export type SetResult =
  | { ok: true; lists: QuestionLists; id: string }
  | { ok: false; error: 'invalid-input' | 'unknown-set' | 'duplicate-name' };

/** Another list already has this name (the Round picker would show two alike). */
const nameTaken = (lists: QuestionLists, name: string, except?: string) => {
  const fold = (n: string) => foldText(n) || n.toLowerCase(); // an emoji-only name stays itself
  const key = fold(name);
  return (
    key === fold(listName(lists, MAIN_SET)) ||
    key === fold(listName(lists, WARMUP_LIST)) ||
    lists.sets.some((s) => s.id !== except && fold(s.name) === key)
  );
};

/** Adds an empty set. */
export function createSet(lists: QuestionLists, rawName: unknown): SetResult {
  const name = setName(rawName);
  if (!name) return { ok: false, error: 'invalid-input' };
  if (nameTaken(lists, name)) return { ok: false, error: 'duplicate-name' };
  const next = copyLists(lists);
  const taken = new Set(next.sets.map((s) => s.id));
  let id: string;
  do
    id = `set-${newId(6)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 6)}`;
  while (!SET_ID.test(id) || taken.has(id));
  next.sets.push({ id, name, questions: [] });
  return { ok: true, lists: next, id };
}

export function renameSet(lists: QuestionLists, id: unknown, rawName: unknown): SetResult {
  const name = setName(rawName);
  if (!name) return { ok: false, error: 'invalid-input' };
  const next = copyLists(lists);
  const set = next.sets.find((s) => s.id === id);
  if (!set) return { ok: false, error: 'unknown-set' };
  if (nameTaken(lists, name, set.id)) return { ok: false, error: 'duplicate-name' };
  set.name = name;
  return { ok: true, lists: next, id: set.id };
}

/** Deletes a set with its questions (the host panel asks first). */
export function deleteSet(lists: QuestionLists, id: unknown): SetResult {
  const next = copyLists(lists);
  const i = next.sets.findIndex((s) => s.id === id);
  if (i < 0) return { ok: false, error: 'unknown-set' };
  const [gone] = next.sets.splice(i, 1);
  return { ok: true, lists: next, id: gone!.id };
}

export type Edit =
  | { type: 'save'; list: QuestionList; question: unknown; index?: unknown }
  | { type: 'delete'; list: QuestionList; id: unknown }
  | { type: 'move'; list: QuestionList; id: unknown; to: unknown };

type EditResult =
  | { ok: true; lists: QuestionLists; id: string }
  | { ok: false; error: 'invalid-input' | 'invalid-question' | 'unknown-question' | 'unknown-set' };

/** A new neutral id (never a hint at the answer), unique across all lists. */
function freshId(lists: QuestionLists, list: QuestionList): string {
  const taken = new Set(
    [...lists.questions, ...lists.warmup, ...lists.sets.flatMap((s) => s.questions)].map(
      (q) => q.id,
    ),
  );
  for (;;) {
    const id = `${list === WARMUP_LIST ? 'w' : list === MAIN_SET ? 'q' : 's'}-${newId(4)
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 6)}`;
    if (id.length > 4 && !taken.has(id)) return id;
  }
}

const onlyLangs = (t: Localized): Localized =>
  Object.fromEntries(LANGS.map((l) => [l, t[l]])) as Localized;

/** Only the known fields of an edited question (anything else a client sends is dropped). */
function clean(raw: EditedQuestion, id: string): Question {
  return {
    id,
    kind: raw.kind,
    // only the five languages (unknown keys inside a text would reach every phone otherwise)
    text: onlyLangs(raw.text),
    options: raw.options.map(onlyLangs),
    correct: raw.correct,
    ...(raw.kind === 'photo' && raw.photo !== undefined ? { photo: raw.photo } : {}),
  };
}

/** Applies one edit to a copy of the lists. The lists given are never changed. */
export function applyEdit(lists: QuestionLists, edit: Edit): EditResult {
  const next = copyLists(lists);
  const items = listOf(next, edit.list);
  if (!items) return { ok: false, error: 'unknown-set' };
  const at = (id: unknown) => (isSafeKey(id) ? items.findIndex((q) => q.id === id) : -1);

  if (edit.type === 'save') {
    const raw = edit.question;
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'invalid-input' };
    const given = (raw as { id?: unknown }).id;
    if (questionProblems(raw).length) return { ok: false, error: 'invalid-question' };
    if (given !== undefined) {
      const i = at(given);
      if (i < 0) return { ok: false, error: 'unknown-question' };
      items[i] = clean(raw as EditedQuestion, items[i]!.id);
      return { ok: true, lists: next, id: items[i].id };
    }
    const id = freshId(lists, edit.list);
    const index =
      Number.isInteger(edit.index) && (edit.index as number) >= 0
        ? Math.min(edit.index as number, items.length)
        : items.length;
    items.splice(index, 0, clean(raw as EditedQuestion, id));
    return { ok: true, lists: next, id };
  }

  const i = at(edit.id);
  if (i < 0) return { ok: false, error: 'unknown-question' };
  const id = items[i]!.id;
  if (edit.type === 'delete') {
    items.splice(i, 1);
    return { ok: true, lists: next, id };
  }
  if (!Number.isInteger(edit.to)) return { ok: false, error: 'invalid-input' };
  const to = Math.max(0, Math.min(edit.to as number, items.length - 1));
  const [moved] = items.splice(i, 1);
  items.splice(to, 0, moved!);
  return { ok: true, lists: next, id };
}

/**
 * Writes content/questions.json atomically (temp file + fsync + rename), keeping the file it
 * replaces as questions.prev.json. One write at a time; the newest lists always win.
 */
export class QuestionWriter {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly contentDir: string,
    private readonly onError: (e: unknown) => void,
    /** After a good write (e.g. to take back an earlier failure's warning). */
    private readonly onSaved: () => void = () => {},
  ) {}

  /** The lists and the countdown of every question (`timeLimitSec`, in seconds). */
  save(lists: QuestionLists, timeLimitSec: number): Promise<void> {
    const file = {
      timeLimitSec,
      ...(lists.couple ? { couple: true } : {}),
      questions: lists.questions,
      warmup: lists.warmup,
      sets: lists.sets,
    };
    const text = `${JSON.stringify(file, null, 2)}\n`;
    this.chain = this.chain
      .then(() => this.write(text))
      .then(this.onSaved)
      .catch(this.onError);
    return this.chain;
  }

  private async write(text: string): Promise<void> {
    const file = join(this.contentDir, 'questions.json');
    const tmp = `${file}.tmp`;
    await mkdir(this.contentDir, { recursive: true });
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(text);
      await handle.sync();
    } catch (e) {
      await handle.close().catch(() => {});
      throw e;
    }
    await handle.close();
    await copyFile(file, join(this.contentDir, 'questions.prev.json')).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // the first real file
    });
    await renameWithRetry(tmp, file);
  }
}
