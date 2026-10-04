// The question editor's decisions, as pure functions (tested); the components only draw.
// The rules themselves are shared with the server (questionProblems, missingLangs).
import {
  LANGS,
  missingLangs,
  questionProblems,
  type EditedQuestion,
  type HostQuestion,
  type Lang,
  type Localized,
  type QuestionKind,
  type Side,
} from '@idoknow/shared';
import { textFit } from '../../screen/logic';

/** A question being edited; the id only when it already exists. (One timer for all: Phase 6.7.) */
export type Draft = EditedQuestion;

/** The same text in every language (names like "Anna" need no translation). */
export const same = (text: string): Localized =>
  Object.fromEntries(LANGS.map((l) => [l, text])) as Localized;
export const blank = (): Localized => same('');

/** The couple's names (content/event.json, from the host view): bride-or-groom's two answers. */
export type Sides = Record<Side, string>;
const NO_SIDES: Sides = { bride: '', groom: '' };
const coupleOf = (sides: Sides): Localized[] => [same(sides.bride), same(sides.groom)];

/** A new, empty question of this kind. Bride-or-groom starts with the couple's names. */
export function emptyDraft(kind: QuestionKind = 'choice', sides: Sides = NO_SIDES): Draft {
  return {
    kind,
    text: blank(),
    options: kind === 'bride-or-groom' ? coupleOf(sides) : [blank(), blank(), blank(), blank()],
    correct: 0,
  };
}

export function fromHost(q: HostQuestion): Draft {
  return {
    id: q.id,
    kind: q.kind,
    text: { ...q.text },
    options: q.options.map((o) => ({ ...o })),
    correct: q.correct,
    ...(q.photo ? { photo: q.photo } : {}),
  };
}

/** A copy to save as a new question (no id). */
export function duplicate(q: HostQuestion): Draft {
  const copy = fromHost(q);
  delete copy.id;
  return copy;
}

/** Another kind: bride-or-groom keeps two answers, a photo question keeps its photo. */
export function changeKind(d: Draft, kind: QuestionKind, sides: Sides = NO_SIDES): Draft {
  const next: Draft = { ...d, kind };
  if (kind === 'bride-or-groom') {
    const kept = d.options.slice(0, 2);
    // nothing typed yet (a new question): start with the couple's names
    const empty = kept.length < 2 || kept.every((o) => LANGS.every((l) => !o[l].trim()));
    next.options = empty ? coupleOf(sides) : kept;
    next.correct = Math.min(d.correct, 1);
  }
  if (kind !== 'photo') delete next.photo;
  return next;
}

export function setText(d: Draft, lang: Lang, value: string): Draft {
  return { ...d, text: { ...d.text, [lang]: value } };
}

export function setOption(d: Draft, index: number, lang: Lang, value: string): Draft {
  return {
    ...d,
    options: d.options.map((o, i) => (i === index ? { ...o, [lang]: value } : o)),
  };
}

export const canAddOption = (d: Draft) => d.kind !== 'bride-or-groom' && d.options.length < 4;
export const canRemoveOption = (d: Draft) => d.kind !== 'bride-or-groom' && d.options.length > 2;

export function addOption(d: Draft): Draft {
  return canAddOption(d) ? { ...d, options: [...d.options, blank()] } : d;
}

/** Removes an answer; the correct one stays the same answer (or the first, if it was removed). */
export function removeOption(d: Draft, index: number): Draft {
  if (!canRemoveOption(d)) return d;
  const correct = d.correct === index ? 0 : d.correct > index ? d.correct - 1 : d.correct;
  return { ...d, options: d.options.filter((_, i) => i !== index), correct };
}

/** Everything that stops a save (the server checks the same rules). */
export const problems = (d: Draft) => questionProblems(d);

/** Languages still to translate (saving is fine; the quiz can't start until they're done). */
export const missing = (d: { text: Localized; options: readonly Localized[] }) => missingLangs(d);

/** Languages whose texts are long enough to be shown small on the big screen. */
export function longIn(d: Draft): Lang[] {
  return LANGS.filter(
    (l) =>
      textFit(
        d.text[l],
        d.options.map((o) => o[l]),
      ) === 'xlong',
  );
}

/** The question's title in lists: English, else the first language that has text. */
export function titleOf(q: { text: Localized }): string {
  const t = q.text.en.trim() || LANGS.map((l) => q.text[l].trim()).find(Boolean);
  return t ?? '(no text yet)';
}

/** What the editor sends (the server drops anything it doesn't know). */
export function toEdited(d: Draft): EditedQuestion {
  return {
    ...(d.id ? { id: d.id } : {}),
    kind: d.kind,
    text: d.text,
    options: d.options,
    correct: d.correct,
    ...(d.kind === 'photo' && d.photo ? { photo: d.photo } : {}),
  };
}
