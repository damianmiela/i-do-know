import { describe, expect, it } from 'vitest';
import type { HostQuestion } from '@idoknow/shared';
import { fitSize } from './photo';
import {
  addOption,
  blank,
  changeKind,
  duplicate,
  emptyDraft,
  longIn,
  missing,
  problems,
  removeOption,
  same,
  setOption,
  setText,
  titleOf,
  toEdited,
} from './logic';

const full = (): HostQuestion => ({
  id: 'q-abc',
  kind: 'choice',
  text: same('Where did they meet?'),
  options: [same('At work'), same('At a party'), same('On Erasmus')],
  correct: 1,
  timeLimitSec: 20,
});

describe('question editor', () => {
  it('a new question needs texts before it can be saved', () => {
    const d = emptyDraft();
    expect(d.options).toHaveLength(4);
    expect(problems(d)).toContain('text is empty');
    const filled = [0, 1, 2, 3].reduce(
      (x, i) => setOption(x, i, 'en', `Answer ${i + 1}`),
      setText(d, 'en', 'Who?'),
    );
    expect(problems(filled)).toEqual([]); // English only is a valid draft
    expect(missing(filled)).toEqual(['pl', 'es', 'ca', 'de']);
  });

  it('bride-or-groom starts with the couple and keeps two answers', () => {
    const sides = { bride: 'Anna', groom: 'Ben' };
    const d = emptyDraft('bride-or-groom', sides);
    expect(d.options.map((o) => o.en)).toEqual(['Anna', 'Ben']);
    expect(addOption(d)).toBe(d);
    const fromChoice = changeKind({ ...emptyDraft(), correct: 3 }, 'bride-or-groom', sides);
    expect(fromChoice.options.map((o) => o.en)).toEqual(['Anna', 'Ben']); // nothing typed yet
    expect(fromChoice.correct).toBe(1);
    const typed = { ...emptyDraft(), options: [same('Mum'), same('Dad'), blank(), blank()] };
    expect(changeKind(typed, 'bride-or-groom', sides).options.map((o) => o.en)).toEqual([
      'Mum',
      'Dad',
    ]);
  });

  it('removing an answer keeps the right answer the same answer', () => {
    const d = { ...emptyDraft(), options: [same('a'), same('b'), same('c')], correct: 2 };
    expect(removeOption(d, 0).correct).toBe(1); // "c" moved up
    expect(removeOption(d, 2).correct).toBe(0); // the right one itself was removed
    expect(removeOption({ ...d, options: [same('a'), same('b')] }, 0).options).toHaveLength(2);
  });

  it('a photo question keeps its photo only while it is one', () => {
    const d = { ...emptyDraft('photo'), photo: 'photo-x.webp' };
    expect(changeKind(d, 'choice').photo).toBeUndefined();
    expect(toEdited(changeKind(d, 'choice'))).not.toHaveProperty('photo');
  });

  it('a copy has no id (it is saved as a new question); titles fall back to other languages', () => {
    expect(duplicate(full())).not.toHaveProperty('id');
    // one timer for all questions: a question carries no time of its own any more
    expect(toEdited(duplicate(full()))).not.toHaveProperty('timeLimitSec');
    expect(titleOf({ text: { ...blank(), de: 'Nur Deutsch' } })).toBe('Nur Deutsch');
    expect(titleOf({ text: blank() })).toBe('(no text yet)');
  });

  it('warns about texts that the big screen must show small', () => {
    expect(longIn(duplicate(full()))).toEqual([]);
    const long = setText(duplicate(full()), 'de', 'x'.repeat(160));
    expect(longIn(long)).toEqual(['de']);
  });
});

describe('photo size', () => {
  it('shrinks the longest side to 1200 px, never enlarges', () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 1200, height: 900 });
    expect(fitSize(3000, 4000)).toEqual({ width: 900, height: 1200 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
