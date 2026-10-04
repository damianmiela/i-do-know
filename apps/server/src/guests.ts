// The guest list: guests.json (personal data, never in git) plus guests the host added at the
// party (kept in the snapshot). Guests pick their name through a search on the server, so the
// whole list never goes to phones.
import { foldText, type NameMatch } from '@idoknow/shared';
import type { Guest } from './game/collect';
import { GUEST_NAME_MAX_LENGTH, SEARCH_MAX_RESULTS, SEARCH_MIN_CHARS } from './game/config';
import { cleanRecord, isSafeKey, own } from './game/safe';

const COUNTRY = /^[A-Z]{2}$/;
/** Guest ids: letters, digits, - and _. */
const GUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Ids of guests the host adds start with this; guests.json may not use it. */
const ADDED_PREFIX = 'added-';
/** Invisible and control characters (e.g. text-direction overrides) never belong in a name. */
export const HIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;

/**
 * The folded words a name can be found by: as is, with umlauts written the German way
 * ("juergen" finds "Jürgen"), and with apostrophes as word breaks ("brien" and "obrien" both
 * find "O'Brien").
 */
export function nameWords(name: string): string[] {
  const variants = [foldText(name), foldText(name, true), foldText(name.replace(/['’ʼ`·]/g, ' '))];
  return [...new Set(variants.join(' ').split(' ').filter(Boolean))];
}

/** Checks one guest; returns a problem or undefined. */
function guestProblem(g: Partial<Guest> | null | undefined): string | undefined {
  if (typeof g !== 'object' || g === null) return 'not an object';
  if (typeof g.id !== 'string' || !GUEST_ID.test(g.id) || !isSafeKey(g.id)) {
    return 'id must be 1 to 64 letters, digits, - or _';
  }
  if (typeof g.name !== 'string' || g.name.length > GUEST_NAME_MAX_LENGTH) {
    return `name must be at most ${GUEST_NAME_MAX_LENGTH} characters`;
  }
  if (HIDDEN_CHARS.test(g.name)) return 'name contains invisible or control characters';
  if (!nameWords(g.name).some((w) => w.length >= SEARCH_MIN_CHARS)) {
    // the search needs a first word of 2+ letters, so "J. K." could never be found
    return `name needs a word of at least ${SEARCH_MIN_CHARS} letters (or it can't be found)`;
  }
  if (typeof g.country !== 'string' || !COUNTRY.test(g.country)) {
    return 'country must be two capital letters like PL, ES, DE';
  }
  if (g.side !== 'bride' && g.side !== 'groom') return 'side must be "bride" or "groom"';
  if (g.role !== undefined && g.role !== 'bride' && g.role !== 'groom') {
    return 'role (if given) must be "bride" or "groom"';
  }
  return undefined;
}

/** Checks a guest list (e.g. from guests.json). Returns problems; empty = valid. */
export function validateGuests(guests: unknown): string[] {
  if (!Array.isArray(guests)) return ['guests must be an array'];
  const errors: string[] = [];
  const ids = new Set<string>();
  guests.forEach((raw: unknown, i) => {
    const g = raw as Partial<Guest> | null;
    const at = `guest ${i + 1} (${String(g?.id)})`;
    const problem = guestProblem(g);
    if (problem) errors.push(`${at}: ${problem}`);
    else if (g!.id!.startsWith(ADDED_PREFIX)) {
      errors.push(`${at}: ids starting with "${ADDED_PREFIX}" are reserved for added guests`);
    } else if (ids.has(g!.id!)) errors.push(`${at}: duplicate id`);
    else ids.add(g!.id!);
  });
  // one bride and one groom at most (Phase 9.5)
  for (const role of ['bride', 'groom'] as const) {
    const marked = guests.filter((g) => (g as Partial<Guest> | null)?.role === role);
    if (marked.length > 1) errors.push(`only one guest can have "role": "${role}"`);
  }
  return errors;
}

/**
 * Warnings for guests with the same name (e.g. father and son): on the phones they'd look
 * identical. Only ids are named, because warnings go to the log too.
 */
export function sameNameWarnings(guests: readonly Guest[]): string[] {
  const byName = new Map<string, string[]>();
  for (const g of guests) {
    const key = foldText(g.name);
    byName.set(key, [...(byName.get(key) ?? []), g.id]);
  }
  return [...byName.values()]
    .filter((ids) => ids.length > 1)
    .map(
      (ids) =>
        `guests.json: ${ids.join(', ')} have the same name, so guests can't tell them apart; add something to the names (e.g. "senior" / "junior")`,
    );
}

/**
 * Rebuilds the host-added guests read from a snapshot. A guest that no longer passes the checks
 * (e.g. saved by an older version) is skipped and its id put in `skipped`, so one bad entry
 * can't make the whole saved game unusable. Throws only if it isn't an object at all.
 */
export function restoreAddedGuests(raw: unknown, skipped: string[] = []): Record<string, Guest> {
  const all = cleanRecord<unknown>(raw ?? {}, () => true, 'addedGuests'); // none before Phase 3
  const out: Record<string, Guest> = {};
  for (const [id, v] of Object.entries(all)) {
    const ok =
      !guestProblem(v as Partial<Guest>) && (v as Guest).id === id && id.startsWith(ADDED_PREFIX);
    if (ok) out[id] = v as Guest;
    else skipped.push(id);
  }
  return out;
}

export type AddGuestResult =
  { ok: true; guest: Guest } | { ok: false; error: 'invalid-input' | 'duplicate-name' };

export class GuestBook {
  /**
   * Every guest by id, from the file and added ones. One shared object: Collect reads it too,
   * so added guests take part in collect mode at once.
   */
  readonly all: Record<string, Guest>;

  constructor(
    listed: readonly Guest[],
    /** Added by the host; this object is what goes into the snapshot. */
    readonly added: Record<string, Guest> = {},
  ) {
    this.all = {};
    for (const g of listed) this.all[g.id] = g;
    for (const g of Object.values(added)) {
      if (own(this.all, g.id)) throw new Error(`Added guest ${g.id} clashes with guests.json`);
      delete g.role; // the couple is marked in guests.json only
      this.all[g.id] = g;
    }
  }

  /** The bride and the groom as marked in guests.json (Phase 9.5), if they are. */
  couple(): { bride?: Guest; groom?: Guest } {
    const listed = Object.values(this.all).filter((g) => !this.isAdded(g.id));
    const bride = listed.find((g) => g.role === 'bride');
    const groom = listed.find((g) => g.role === 'groom');
    return { ...(bride ? { bride } : {}), ...(groom ? { groom } : {}) };
  }

  get(id: string): Guest | undefined {
    return own(this.all, id);
  }

  isAdded(id: string): boolean {
    return own(this.added, id) !== undefined;
  }

  /** Host: removes a guest they added (guests.json is edited in the file). False otherwise. */
  remove(id: string): boolean {
    if (!this.isAdded(id)) return false;
    delete this.added[id];
    delete this.all[id];
    return true;
  }

  /**
   * Accent-insensitive search: every typed word must start a word of the name, in any order
   * ("luk" → Łukasz, "nuria" → Núria, "wis luk" → Łukasz Wiśniewski).
   * Returns undefined when the query is too short.
   */
  search(query: string, isTaken: (id: string) => boolean): NameMatch[] | undefined {
    const typed = foldText(query).split(' ').filter(Boolean);
    // the first word needs 2+ letters: "a b" would match almost everyone
    if ((typed[0]?.length ?? 0) < SEARCH_MIN_CHARS) return undefined;
    return Object.values(this.all)
      .filter((g) => {
        const words = nameWords(g.name);
        return typed.every((t) => words.some((w) => w.startsWith(t)));
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, SEARCH_MAX_RESULTS)
      .map((g) => ({ id: g.id, name: g.name, country: g.country, taken: isTaken(g.id) }));
  }

  /**
   * Host: adds a guest missing from the list. A name that already exists is refused unless
   * `allowDuplicate` is true (namesakes do exist: the host panel asks first).
   */
  add(raw: {
    name?: unknown;
    country?: unknown;
    side?: unknown;
    allowDuplicate?: unknown;
  }): AddGuestResult {
    const name =
      typeof raw.name === 'string'
        ? raw.name.replace(new RegExp(HIDDEN_CHARS, 'gu'), '').trim().replace(/\s+/g, ' ')
        : '';
    let n = Object.keys(this.added).length + 1;
    while (own(this.all, `${ADDED_PREFIX}${n}`)) n++;
    const guest = {
      id: `${ADDED_PREFIX}${n}`,
      name,
      country: raw.country,
      side: raw.side,
    } as Guest;
    if (guestProblem(guest)) return { ok: false, error: 'invalid-input' };
    const folded = foldText(name);
    if (
      raw.allowDuplicate !== true &&
      Object.values(this.all).some((g) => foldText(g.name) === folded)
    ) {
      return { ok: false, error: 'duplicate-name' };
    }
    this.added[guest.id] = guest;
    this.all[guest.id] = guest;
    return { ok: true, guest };
  }
}
