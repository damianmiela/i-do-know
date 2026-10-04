import { describe, expect, it } from 'vitest';
import type { Localized } from '@idoknow/shared';
import type { Question } from './game/quiz';
import type { QuestionLists } from './questionStore';
import {
  applyQuestionFixes,
  parseCsv,
  QUESTION_HEADER,
  questionRows,
  toCsv,
  UI_HEADER,
  uiRows,
} from './translations';

const t = (en: string, pl = `${en} (pl)`): Localized => ({ en, pl, es: '', ca: '', de: '' });
const q = (id: string): Question => ({
  id,
  kind: 'choice',
  text: t(`Question ${id}?`),
  options: [t('Yes'), t('No')],
  correct: 0,
});
const lists = (): QuestionLists => ({
  questions: [q('q1')],
  warmup: [q('w1')],
  sets: [{ id: 'set-ab', name: 'Family', questions: [q('s1')] }],
});

describe('CSV', () => {
  it('round-trips quotes, commas, line breaks and accents; reads semicolons too', () => {
    const rows = [
      ['a', 'with, comma', 'with "quotes"'],
      ['two\nlines', 'Łódź ñ ß', ' spaced '],
    ];
    const csv = toCsv(rows);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parseCsv(csv)).toEqual(rows);
    expect(parseCsv('a;b;"c;d"\n1;2;3\n\n')).toEqual([
      ['a', 'b', 'c;d'],
      ['1', '2', '3'],
    ]);
  });
});

describe('the UI sheet', () => {
  it('one row per text and per plural form, drafts next to English', () => {
    const empty = { one: '', other: '' };
    const rows = uiRows('Phone', {
      en: { hi: 'Hi {name}', n: { one: '{n} place', other: '{n} places' } },
      pl: {
        hi: 'Cześć {name}',
        n: { one: '{n} miejsce', few: '{n} miejsca', other: '{n} miejsc' },
      },
      es: { hi: 'Hola {name}', n: empty },
      ca: { hi: 'Hola {name}', n: empty },
      de: { hi: 'Hallo {name}', n: empty },
    });
    expect(rows.map((r) => r.slice(0, 5))).toEqual([
      ['Phone', 'hi', '', 'Hi {name}', 'Cześć {name}'],
      ['Phone', 'n', 'one', '{n} place', '{n} miejsce'],
      ['Phone', 'n', 'few', '', '{n} miejsca'],
      ['Phone', 'n', 'other', '{n} places', '{n} miejsc'],
    ]);
    expect(rows.every((r) => r.length === UI_HEADER.length)).toBe(true);
  });
});

describe('the question sheet', () => {
  it('lists every question and answer of every list', () => {
    const rows = questionRows(lists());
    expect(rows.map((r) => r.slice(0, 3))).toEqual([
      ['Main quiz', 'q1', 'question'],
      ['Main quiz', 'q1', 'answer 1'],
      ['Main quiz', 'q1', 'answer 2'],
      ['Warm-up', 'w1', 'question'],
      ['Warm-up', 'w1', 'answer 1'],
      ['Warm-up', 'w1', 'answer 2'],
      ['Family', 's1', 'question'],
      ['Family', 's1', 'answer 1'],
      ['Family', 's1', 'answer 2'],
    ]);
    expect(rows.every((r) => r.length === QUESTION_HEADER.length)).toBe(true);
    expect(rows.every((r) => r.at(-1) === '')).toBe(true); // nothing long
  });

  it('notes where a text is long for the big screen', () => {
    const l = lists();
    l.questions[0]!.text.de = 'x'.repeat(101);
    l.questions[0]!.options[1]!.pl = 'y'.repeat(29);
    const rows = questionRows(l);
    expect(rows[0]!.at(-1)).toBe('long in DE: shorter reads better (max 100 letters)');
    expect(rows[2]!.at(-1)).toBe('long in PL: shorter reads better (max 28 letters)');
  });

  it('applies the fixed cells, keeps the drafts where empty, and reports unknown rows', () => {
    const before = lists();
    const fix = (row: string[], lang: string, text: string) => {
      row[QUESTION_HEADER.indexOf(`${lang} fixed`)] = text;
      return row;
    };
    const rows = questionRows(before);
    const sheet = parseCsv(
      toCsv([
        QUESTION_HEADER,
        fix(rows[0]!, 'PL', '  Pytanie pierwsze?  '),
        fix(fix(rows[7]!, 'DE', 'Ja'), 'EN', 'Yes!'),
        rows[1]!, // nothing fixed
        fix(['Main quiz', 'q9', 'question', ...rows[0]!.slice(3)], 'ES', 'x'),
        fix(['Main quiz', 'q1', 'answer 5', ...rows[0]!.slice(3)], 'ES', 'x'),
      ]),
    );
    const { lists: after, changed, problems } = applyQuestionFixes(before, sheet);
    expect(changed).toBe(3);
    expect(after.questions[0]!.text.pl).toBe('Pytanie pierwsze?');
    expect(after.sets[0]!.questions[0]!.options[0]).toMatchObject({ en: 'Yes!', de: 'Ja' });
    expect(before.questions[0]!.text.pl).toBe('Question q1? (pl)'); // the input stays as it was
    expect(problems).toEqual([
      'line 5: no question "q9" with a part "question"',
      'line 6: no question "q1" with a part "answer 5"',
    ]);
  });

  it('refuses a sheet that is not the question sheet', () => {
    expect(applyQuestionFixes(lists(), [UI_HEADER]).problems).toHaveLength(1);
  });
});
