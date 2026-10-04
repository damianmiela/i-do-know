import type { CollectError, Side } from '@idoknow/shared';
import {
  BAND_CODE_MAX_LENGTH,
  COLLECT_FAILED_MAX,
  COLLECT_BASE_POINTS,
  COLLECT_OTHER_COUNTRY_BONUS,
  COLLECT_OTHER_SIDE_BONUS,
  COLLECT_RATE_MAX,
  COLLECT_RATE_WINDOW_MS,
} from './config';
import { cleanRecord, isNum, isSafeKey, own } from './safe';

export type { CollectError, Side };

export interface Guest {
  id: string;
  name: string;
  /** e.g. "PL", "ES", "DE" */
  country: string;
  side: Side;
  /**
   * The bride or the groom themselves (Phase 9.5): in a question set where "the couple plays
   * along" they answer off the leaderboard. Only in guests.json, at most one of each.
   */
  role?: Side;
}

/** Plain JSON: this is what gets snapshotted to disk. */
export interface CollectState {
  /** Wristband code → guest id ("this is me"). */
  bands: Record<string, string>;
  /** Collector id → collected guest id → points earned for that guest. */
  scans: Record<string, Record<string, number>>;
  /** Collector id → times of recent successful scans (for the rate limit). */
  recent: Record<string, number[]>;
  /** Collector id → times of recent failed scans with wrong/unknown codes (stops code guessing). */
  failed: Record<string, number[]>;
}

export type Bonus = 'other-country' | 'other-side';

export type ScanResult =
  | { ok: true; target: Guest; points: number; bonuses: Bonus[] }
  | { ok: false; error: CollectError };

/** `changed: false` = this band was already linked to this guest (nothing to save or send). */
export type ClaimResult = { ok: true; changed: boolean } | { ok: false; error: CollectError };

export interface CollectRanked {
  id: string;
  name: string;
  points: number;
  people: number;
  rank: number;
}

export function initialCollectState(): CollectState {
  return { bands: {}, scans: {}, recent: {}, failed: {} };
}

const isTimes = (v: unknown) => Array.isArray(v) && v.every(isNum);

/** Rebuilds a collect snapshot read from disk; throws if it isn't valid. */
export function restoreCollectState(raw: unknown): CollectState {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid snapshot: collect state');
  const r = raw as Record<string, unknown>;
  return {
    bands: cleanRecord<string>(
      r.bands,
      (v, code) => normalizeCode(code) === code && isSafeKey(v),
      'bands',
    ),
    scans: cleanRecord<Record<string, number>>(
      r.scans,
      (v, key) => {
        cleanRecord<number>(v, isNum, `scans.${key}`);
        return true;
      },
      'scans',
    ),
    // rate-limit history is optional: losing it only resets the limits
    recent: cleanRecord<number[]>(r.recent ?? {}, isTimes, 'recent'),
    failed: cleanRecord<number[]>(r.failed ?? {}, isTimes, 'failed'),
  };
}

/** Codes are printed like "K7P2"; accept "k7p2 " too. Returns undefined for anything that can't be a code. */
export function normalizeCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > BAND_CODE_MAX_LENGTH * 2) return undefined;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]+$/.test(code) && code.length <= BAND_CODE_MAX_LENGTH ? code : undefined;
}

const withinWindow = (times: number[] | undefined, now: number) =>
  (times ?? []).filter((t) => now - t < COLLECT_RATE_WINDOW_MS);

/**
 * "Collect the other family": guests scan each other's wristbands.
 * Each person counts once per collector. Light anti-cheat: a rate limit per collector.
 */
export class Collect {
  constructor(
    /** Guest list by id. Shared with the rest of the app, so added guests show up here too. */
    readonly guests: Readonly<Record<string, Guest>>,
    readonly state: CollectState = initialCollectState(),
    /**
     * The codes actually printed on wristbands (from the generator, Phase 7).
     * When given, any other code is rejected, so nobody can claim or scan made-up codes.
     */
    readonly validCodes?: ReadonlySet<string>,
  ) {
    for (const [key, guest] of Object.entries(guests)) {
      if (!isSafeKey(key) || guest.id !== key) throw new Error(`Invalid guest id: ${key}`);
    }
  }

  private code(raw: unknown): string | undefined {
    const code = normalizeCode(raw);
    return code && (!this.validCodes || this.validCodes.has(code)) ? code : undefined;
  }

  bandOf(guestId: string): string | undefined {
    return Object.entries(this.state.bands).find(([, id]) => id === guestId)?.[0];
  }

  /** "This is me": links a wristband to a guest. */
  claimBand(guestId: string, rawCode: unknown): ClaimResult {
    if (!own(this.guests, guestId)) return { ok: false, error: 'unknown-guest' };
    const code = this.code(rawCode);
    if (!code) return { ok: false, error: 'invalid-code' };
    const owner = own(this.state.bands, code);
    if (owner === guestId) return { ok: true, changed: false };
    if (owner) return { ok: false, error: 'band-taken' };
    if (this.bandOf(guestId)) return { ok: false, error: 'already-has-band' };
    this.state.bands[code] = guestId;
    return { ok: true, changed: true };
  }

  /** Host action: unlink a wristband (wrong band claimed). Collected points stay. */
  /** A guest removed from the list: their band, their scans, and their place in others' scans. */
  forget(guestId: string): void {
    const s = this.state;
    for (const [code, id] of Object.entries(s.bands)) if (id === guestId) delete s.bands[code];
    for (const record of [s.scans, s.recent, s.failed]) {
      if (Object.hasOwn(record, guestId)) delete (record as Record<string, unknown>)[guestId];
    }
    for (const collected of Object.values(s.scans)) {
      if (Object.hasOwn(collected, guestId)) delete collected[guestId];
    }
  }

  releaseBand(rawCode: unknown): void {
    const code = normalizeCode(rawCode);
    if (code) delete this.state.bands[code];
  }

  scan(collectorId: string, rawCode: unknown, now: number): ScanResult {
    const s = this.state;
    const collector = own(this.guests, collectorId);
    if (!collector || !isSafeKey(collector.id)) return { ok: false, error: 'unknown-guest' };

    // wrong codes count against a limit, so a script can't guess codes;
    // a camera firing repeatedly on the same real band doesn't
    const failed = withinWindow(own(s.failed, collector.id), now);
    if (failed.length >= COLLECT_FAILED_MAX) return { ok: false, error: 'rate-limited' };
    const wrongCode = (error: CollectError): ScanResult => {
      s.failed[collector.id] = [...failed, now];
      return { ok: false, error };
    };

    const code = this.code(rawCode);
    if (!code) return wrongCode('invalid-code');
    const targetId = own(s.bands, code);
    const target = targetId ? own(this.guests, targetId) : undefined;
    if (!target || !isSafeKey(target.id)) return wrongCode('unknown-band');
    if (target.id === collector.id) return { ok: false, error: 'self' };
    const mine = own(s.scans, collector.id) ?? {};
    if (own(mine, target.id) !== undefined) return { ok: false, error: 'already-collected' };

    const recent = withinWindow(own(s.recent, collector.id), now);
    if (recent.length >= COLLECT_RATE_MAX) return { ok: false, error: 'rate-limited' };
    s.recent[collector.id] = [...recent, now];

    const bonuses: Bonus[] = [];
    if (target.country !== collector.country) bonuses.push('other-country');
    if (target.side !== collector.side) bonuses.push('other-side');
    const points =
      COLLECT_BASE_POINTS +
      (bonuses.includes('other-country') ? COLLECT_OTHER_COUNTRY_BONUS : 0) +
      (bonuses.includes('other-side') ? COLLECT_OTHER_SIDE_BONUS : 0);
    mine[target.id] = points;
    s.scans[collector.id] = mine;
    return { ok: true, target, points, bonuses };
  }

  /** Points desc, then number of people desc. Equal on both = shared rank. */
  ranking(): CollectRanked[] {
    const rows = Object.entries(this.state.scans)
      .map(([id, got]) => ({
        id,
        name: own(this.guests, id)?.name ?? id,
        points: Object.values(got).reduce((a, b) => a + b, 0),
        people: Object.keys(got).length,
      }))
      .filter((r) => r.people > 0)
      .sort((a, b) => b.points - a.points || b.people - a.people || a.name.localeCompare(b.name));
    let rank = 0;
    return rows.map((r, i) => {
      const prev = rows[i - 1];
      if (!prev || prev.points !== r.points || prev.people !== r.people) rank = i + 1;
      return { ...r, rank };
    });
  }

  /** For the big screen: total scans and how many crossed the two families. */
  stats(): { scans: number; crossSide: number; countryPairs: Record<string, number> } {
    let scans = 0;
    let crossSide = 0;
    const countryPairs: Record<string, number> = {};
    for (const [collectorId, got] of Object.entries(this.state.scans)) {
      const c = own(this.guests, collectorId);
      for (const targetId of Object.keys(got)) {
        const t = own(this.guests, targetId);
        if (!c || !t) continue;
        scans += 1;
        if (c.side !== t.side) crossSide += 1;
        if (c.country !== t.country) {
          const key = [c.country, t.country].sort().join('+');
          countryPairs[key] = (countryPairs[key] ?? 0) + 1;
        }
      }
    }
    return { scans, crossSide, countryPairs };
  }
}
