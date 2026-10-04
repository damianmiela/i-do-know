import { readFileSync } from 'node:fs';
import { foldText } from '@idoknow/shared';
import { describe, expect, it } from 'vitest';
import type { Guest } from './game/collect';
import { SEARCH_MAX_RESULTS } from './game/config';
import { GuestBook, restoreAddedGuests, sameNameWarnings, validateGuests } from './guests';

// the fake example list: names with Polish, Spanish and German letters
const example = (
  JSON.parse(
    readFileSync(new URL('../../../content/guests.example.json', import.meta.url), 'utf8'),
  ) as {
    guests: Guest[];
  }
).guests;
const none = () => false;
const names = (book: GuestBook, q: string) => book.search(q, none)?.map((m) => m.name);

describe('foldText', () => {
  it('drops accents and maps special letters', () => {
    expect(foldText('Łukasz Wiśniewski')).toBe('lukasz wisniewski');
    expect(foldText('Núria Puigdomènech')).toBe('nuria puigdomenech');
    expect(foldText('Jürgen Weiß')).toBe('jurgen weiss');
    expect(foldText('Małgorzata Żółkiewska')).toBe('malgorzata zolkiewska');
    expect(foldText('Jordi Castañer')).toBe('jordi castaner');
    expect(foldText("  Anne-Marie  O'Neil ")).toBe('anne marie oneil');
    expect(foldText('Paral·lel Çà')).toBe('parallel ca');
  });

  it('handles other letters, ligatures, full-width text and other scripts', () => {
    expect(foldText('Yıldız İnce')).toBe('yildiz ince');
    expect(foldText('Cœur Þór Guðrún')).toBe('coeur thor gudrun');
    expect(foldText('ﬁona Ｊürgen')).toBe('fiona jurgen');
    expect(foldText('Олена Шевченко')).toBe('олена шевченко');
    expect(foldText('🎉 Ana 🎉')).toBe('ana');
  });

  it('can write umlauts the German way', () => {
    expect(foldText('Jürgen Müller-Schön Äbi', true)).toBe('juergen mueller schoen aebi');
  });
});

describe('validateGuests', () => {
  it('accepts the example list', () => {
    expect(validateGuests(example)).toEqual([]);
  });

  it('reports every problem', () => {
    const errors = validateGuests([
      { id: 'a', name: 'Ann', country: 'PL', side: 'bride' },
      { id: 'a', name: 'Ann Two', country: 'PL', side: 'bride' },
      { id: '__proto__', name: 'Xavi', country: 'PL', side: 'bride' },
      { id: 'b', name: ' ', country: 'PL', side: 'bride' },
      { id: 'c', name: 'Cid', country: 'Poland', side: 'bride' },
      { id: 'd', name: 'Dan', country: 'PL', side: 'both' },
      null,
      { id: 'e f', name: 'Eva', country: 'PL', side: 'bride' },
      { id: 'added-1', name: 'Fay', country: 'PL', side: 'bride' },
      { id: 'g', name: 'Gil\u202Eevil', country: 'PL', side: 'bride' },
      { id: 'h', name: '🎉', country: 'PL', side: 'bride' },
      { id: 'i', name: 'J. K.', country: 'PL', side: 'bride' }, // no word could be searched
    ]);
    expect(errors).toHaveLength(11);
    expect(errors.join('\n')).toMatch(
      /duplicate id[\s\S]*id must[\s\S]*2 letters[\s\S]*country[\s\S]*side[\s\S]*not an object[\s\S]*id must[\s\S]*reserved[\s\S]*invisible[\s\S]*2 letters/,
    );
    expect(validateGuests({})).toEqual(['guests must be an array']);
  });
});

describe('sameNameWarnings', () => {
  it('names only the ids of guests with the same name', () => {
    const w = sameNameWarnings([
      ...example,
      { id: 'x1', name: 'lukasz NOWAK', country: 'PL', side: 'bride' },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/g006, x1 have the same name/);
    expect(w[0]).not.toMatch(/Nowak/i);
    expect(sameNameWarnings(example)).toEqual([]);
  });
});

describe('search', () => {
  const book = new GuestBook(example);

  it('ignores accents and special letters', () => {
    expect(names(book, 'luk')).toEqual(['Lukas Becker', 'Łukasz Nowak', 'Łukasz Wiśniewski']);
    expect(names(book, 'nuria')).toEqual(['Núria Puigdomènech', 'Núria Vidal']);
    expect(names(book, 'jurgen')).toEqual(['Jürgen Weiß']);
    expect(names(book, 'WEISS')).toEqual(['Jürgen Weiß']);
    expect(names(book, 'zol')).toEqual(['Małgorzata Żółkiewska']);
  });

  it('matches word starts in any order', () => {
    expect(names(book, 'wis luk')).toEqual(['Łukasz Wiśniewski']);
    expect(names(book, 'kasz')).toEqual([]); // not the middle of a word
  });

  it('needs at least 2 letters in the first word', () => {
    expect(book.search('l', none)).toBeUndefined();
    expect(book.search('  ', none)).toBeUndefined();
    expect(book.search('--', none)).toBeUndefined();
    expect(book.search('l n', none)).toBeUndefined(); // one-letter words would match everyone
    expect(names(book, 'lu n')).toEqual(['Łukasz Nowak']);
  });

  it('finds German umlauts written as ue/oe/ae, and names with apostrophes', () => {
    expect(names(book, 'juergen')).toEqual(['Jürgen Weiß']);
    const more = new GuestBook([
      { id: 'o', name: "Siobhan O'Brien", country: 'ES', side: 'bride' },
      { id: 'c', name: 'Pere Col·lell', country: 'ES', side: 'groom' },
    ]);
    expect(names(more, 'obrien')).toEqual(["Siobhan O'Brien"]);
    expect(names(more, 'brien')).toEqual(["Siobhan O'Brien"]);
    expect(names(more, 'collell')).toEqual(['Pere Col·lell']);
    expect(names(more, 'lell')).toEqual(['Pere Col·lell']);
  });

  it('finds names saved with separate accent marks (e.g. files edited on a Mac)', () => {
    const mac = new GuestBook([
      { id: 'm', name: 'Ju\u0308rgen Mu\u0308ller', country: 'DE', side: 'bride' },
    ]);
    expect(names(mac, 'jurgen')).toHaveLength(1);
    expect(names(mac, 'juergen mueller')).toHaveLength(1);
  });

  it('returns at most a few results with only id, name, country and taken', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      name: `Maria ${String.fromCharCode(65 + i)}`,
      country: 'ES',
      side: 'bride' as const,
    }));
    const results = new GuestBook(many).search('maria', (id) => id === 'm0')!;
    expect(results).toHaveLength(SEARCH_MAX_RESULTS);
    expect(results[0]).toEqual({ id: 'm0', name: 'Maria A', country: 'ES', taken: true });
  });
});

describe('adding guests', () => {
  it('adds a guest with a new id, visible in search and in the shared list', () => {
    const book = new GuestBook(example);
    const r = book.add({ name: '  Pau   Serra ', country: 'ES', side: 'groom' });
    expect(r).toEqual({
      ok: true,
      guest: { id: 'added-1', name: 'Pau Serra', country: 'ES', side: 'groom' },
    });
    expect(names(book, 'pau')).toEqual(['Pau Serra']);
    expect(book.all['added-1']).toBeDefined();
    expect(book.added['added-1']).toBeDefined();
    expect(book.add({ name: 'Ola', country: 'PL', side: 'bride' })).toMatchObject({
      guest: { id: 'added-2' },
    });
  });

  it('refuses bad input and names that already exist (ignoring accents and case)', () => {
    const book = new GuestBook(example);
    expect(book.add({ name: '', country: 'ES', side: 'groom' })).toMatchObject({ ok: false });
    expect(book.add({ name: 'X', country: 'es', side: 'groom' })).toMatchObject({ ok: false });
    expect(book.add({ name: 'X', country: 'ES', side: 'x' })).toMatchObject({ ok: false });
    expect(book.add({ name: 'x'.repeat(81), country: 'ES', side: 'groom' })).toMatchObject({
      ok: false,
    });
    expect(book.add({ name: 'lukasz nowak', country: 'PL', side: 'groom' })).toEqual({
      ok: false,
      error: 'duplicate-name',
    });
    expect(book.add({ name: '🎉🎉', country: 'PL', side: 'groom' })).toMatchObject({ ok: false });
  });

  it('adds a namesake when the host confirms, and strips invisible characters', () => {
    const book = new GuestBook(example);
    expect(
      book.add({ name: 'Łukasz Nowak', country: 'PL', side: 'bride', allowDuplicate: true }),
    ).toMatchObject({ ok: true });
    expect(book.add({ name: 'Ana\u202E\u0000 Ruiz', country: 'ES', side: 'bride' })).toMatchObject({
      guest: { name: 'Ana Ruiz' },
    });
  });

  it('restores added guests from a snapshot, skipping ones that no longer pass the checks', () => {
    const g = { id: 'added-1', name: 'Pau', country: 'ES', side: 'groom' };
    expect(restoreAddedGuests({ 'added-1': g })).toEqual({ 'added-1': g });
    expect(restoreAddedGuests(undefined)).toEqual({});
    const skipped: string[] = [];
    const bad = {
      other: g, // key doesn't match the id
      'added-2': { ...g, id: 'added-2', side: 'x' },
      g001: { ...g, id: 'g001' }, // not an added id
      'added-3': { ...g, id: 'added-3', name: 'X Y' }, // can't be searched
      'added-4': { ...g, id: 'added-4' },
    };
    expect(Object.keys(restoreAddedGuests(bad, skipped))).toEqual(['added-4']);
    expect(skipped).toEqual(['other', 'added-2', 'g001', 'added-3']);
    expect(() => restoreAddedGuests([])).toThrow();
  });

  it('refuses an added guest whose id clashes with the list', () => {
    const g: Guest = { id: 'g001', name: 'Pau', country: 'ES', side: 'groom' };
    expect(() => new GuestBook(example, { g001: g })).toThrow(/clashes/);
  });
});

describe('the couple (Phase 9.5)', () => {
  const g = (id: string, role?: string) => ({
    id,
    name: `Guest ${id}`,
    country: 'PL',
    side: 'bride',
    ...(role ? { role } : {}),
  });

  it('marks one bride and one groom in guests.json', () => {
    expect(validateGuests([g('a', 'bride'), g('b', 'groom'), g('c')])).toEqual([]);
    expect(validateGuests([g('a', 'bride'), g('b', 'bride')])).toEqual([
      'only one guest can have "role": "bride"',
    ]);
    expect(validateGuests([g('a', 'mother')])).toEqual([
      'guest 1 (a): role (if given) must be "bride" or "groom"',
    ]);
    const book = new GuestBook([g('a', 'bride'), g('b', 'groom'), g('c')] as Guest[]);
    expect(book.couple()).toMatchObject({ bride: { id: 'a' }, groom: { id: 'b' } });
    expect(new GuestBook([g('c')] as Guest[]).couple()).toEqual({});
  });

  it('never from the host panel: an added guest carries no role', () => {
    const added = { 'added-1': { ...g('added-1'), role: 'groom' } } as Record<string, Guest>;
    const book = new GuestBook([g('a', 'bride')] as Guest[], added);
    expect(book.get('added-1')?.role).toBeUndefined();
    expect(book.couple()).toMatchObject({ bride: { id: 'a' } });
    expect(book.couple().groom).toBeUndefined();
  });
});
