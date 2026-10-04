// Translation review (Phase 9): every text in one spreadsheet (CSV) that native speakers fill in,
// and the way back for the questions. Pure functions; `scripts/texts.mjs` reads and writes the
// files. The UI texts are applied by hand from the returned sheet (they live in TypeScript); the
// questions are private, so their sheet stays in content/ (git-ignored) and is applied here.
import { LANGS, MAIN_SET, WARMUP_LIST, type Lang, type Localized } from '@idoknow/shared';
import type { QuestionLists } from './questionStore';

/** A UI text as the client keeps it: plain, or plural forms (Intl.PluralRules categories). */
export type ReviewText = string | Partial<Record<PluralForm, string>>;
export type PluralForm = 'one' | 'few' | 'many' | 'other';
const FORMS: readonly PluralForm[] = ['one', 'few', 'many', 'other'];

/** English first (the reference), then the drafts. */
const ORDER: readonly Lang[] = ['en', ...LANGS.filter((l) => l !== 'en')];
/** The columns reviewers fill in: a corrected text per language (empty = the draft is fine). */
const FIX = ORDER.map((l) => `${l.toUpperCase()} fixed`);
const DRAFT = ORDER.map((l) => l.toUpperCase());

// ---------- CSV (RFC 4180; what Google Sheets and Excel read and write) ----------

const cell = (v: string) =>
  /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** Rows as CSV, with a BOM so Excel reads the accents (ł, ñ, ß) as UTF-8. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return `\uFEFF${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** Reads CSV (comma or semicolon, as some Excel versions save it). Empty lines are dropped. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(value);
      value = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  if (value !== '' || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// ---------- the UI texts ----------

/**
 * The phone's or the big screen's texts as sheet rows: one row per text (per plural form), the
 * drafts next to English and an empty "fixed" column per language.
 */
export function uiRows(
  where: string,
  messages: Record<Lang, Record<string, ReviewText>>,
): string[][] {
  const rows: string[][] = [];
  for (const [key, en] of Object.entries(messages.en)) {
    const forms =
      typeof en === 'string'
        ? [undefined]
        : FORMS.filter((f) =>
            LANGS.some(
              (l) => typeof messages[l][key] === 'object' && f in (messages[l][key] as object),
            ),
          );
    for (const form of forms) {
      const text = (l: Lang) => {
        const t = messages[l][key];
        return form === undefined
          ? typeof t === 'string'
            ? t
            : ''
          : ((t as Partial<Record<PluralForm, string>>)?.[form] ?? '');
      };
      rows.push([where, key, form ?? '', ...ORDER.map(text), ...FIX.map(() => ''), '']);
    }
  }
  return rows;
}

export const UI_HEADER = ['where', 'key', 'plural form', ...DRAFT, ...FIX, 'note'];

// ---------- the questions ----------

/** Longer than this shows smaller on the big screen (as `textFit()` in screen/logic.ts). */
export const LONG_QUESTION = 100;
export const LONG_ANSWER = 28;

export const QUESTION_HEADER = ['list', 'id', 'part', ...DRAFT, ...FIX, 'note'];

const listLabel = (lists: QuestionLists, list: string) =>
  list === MAIN_SET
    ? 'Main quiz'
    : list === WARMUP_LIST
      ? 'Warm-up'
      : (lists.sets.find((s) => s.id === list)?.name ?? list);

/** Every list's questions and answers as sheet rows (question, then answer 1, 2, …). */
export function questionRows(lists: QuestionLists): string[][] {
  const all: [string, QuestionLists['questions']][] = [
    [MAIN_SET, lists.questions],
    [WARMUP_LIST, lists.warmup],
    ...lists.sets.map((s): [string, QuestionLists['questions']] => [s.id, s.questions]),
  ];
  const row = (list: string, id: string, part: string, t: Localized) => {
    // the big screen shows longer texts smaller (textFit): tell the reviewers where to be brief
    const max = part === 'question' ? LONG_QUESTION : LONG_ANSWER;
    const long = ORDER.filter((l) => (t[l] ?? '').length > max);
    return [
      listLabel(lists, list),
      id,
      part,
      ...ORDER.map((l) => t[l] ?? ''),
      ...FIX.map(() => ''),
      long.length
        ? `long in ${long.map((l) => l.toUpperCase()).join(', ')}: shorter reads better (max ${max} letters)`
        : '',
    ];
  };
  return all.flatMap(([list, qs]) =>
    qs.flatMap((q) => [
      row(list, q.id, 'question', q.text),
      ...q.options.map((o, i) => row(list, q.id, `answer ${i + 1}`, o)),
    ]),
  );
}

export interface Applied {
  lists: QuestionLists;
  /** How many texts changed. */
  changed: number;
  /** Rows that couldn't be applied (unknown question or part, a broken sheet). */
  problems: string[];
}

/**
 * Puts the "fixed" cells of a returned question sheet into the lists (a copy). Empty cells keep
 * the draft; spaces around a text are trimmed.
 */
export function applyQuestionFixes(lists: QuestionLists, table: string[][]): Applied {
  const next = structuredClone(lists);
  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name.toLowerCase());
  const [idCol, partCol] = [col('id'), col('part')];
  if (idCol < 0 || partCol < 0) {
    return {
      lists,
      changed: 0,
      problems: ['This is not the question sheet (no "id" and "part" columns).'],
    };
  }
  const byId = new Map(
    [...next.questions, ...next.warmup, ...next.sets.flatMap((s) => s.questions)].map((q) => [
      q.id,
      q,
    ]),
  );
  const problems: string[] = [];
  let changed = 0;
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const fixes = ORDER.map((l, n) => [l, (r[col(FIX[n]!)] ?? '').trim()] as const).filter(
      ([, v]) => v,
    );
    if (!fixes.length) return;
    const id = (r[idCol] ?? '').trim();
    const part = (r[partCol] ?? '').trim().toLowerCase();
    const q = byId.get(id);
    const answer = /^answer (\d)$/.exec(part);
    const target =
      part === 'question' ? q?.text : answer ? q?.options[Number(answer[1]) - 1] : undefined;
    if (!q || !target) {
      problems.push(`line ${line}: no question "${id}" with a part "${part}"`);
      return;
    }
    for (const [lang, text] of fixes) {
      if (target[lang] !== text) {
        target[lang] = text;
        changed++;
      }
    }
  });
  return { lists: next, changed, problems };
}
