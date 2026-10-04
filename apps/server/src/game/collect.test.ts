import { describe, expect, it } from 'vitest';
import { Collect, restoreCollectState, type CollectState, type Guest } from './collect';
import { COLLECT_FAILED_MAX, COLLECT_RATE_MAX, COLLECT_RATE_WINDOW_MS } from './config';

const guests: Record<string, Guest> = {
  lukasz: { id: 'lukasz', name: 'Łukasz', country: 'PL', side: 'bride' },
  kasia: { id: 'kasia', name: 'Kasia', country: 'PL', side: 'bride' },
  jurgen: { id: 'jurgen', name: 'Jürgen', country: 'DE', side: 'bride' },
  jordi: { id: 'jordi', name: 'Jordi', country: 'ES', side: 'groom' },
  marta: { id: 'marta', name: 'Marta', country: 'PL', side: 'groom' },
};

function setup() {
  const c = new Collect(guests);
  c.claimBand('lukasz', 'L001');
  c.claimBand('kasia', 'K002');
  c.claimBand('jurgen', 'J003');
  c.claimBand('jordi', 'J004');
  c.claimBand('marta', 'M005');
  return c;
}

describe('wristband claim', () => {
  it('links a band to a guest; codes are case- and space-insensitive', () => {
    const c = new Collect(guests);
    expect(c.claimBand('lukasz', ' k7p2 ')).toEqual({ ok: true, changed: true });
    expect(c.bandOf('lukasz')).toBe('K7P2');
    expect(c.claimBand('lukasz', 'K7P2')).toEqual({ ok: true, changed: false }); // same again is fine
  });

  it('refuses a band someone else has, a second band, and unknown guests', () => {
    const c = new Collect(guests);
    c.claimBand('lukasz', 'K7P2');
    expect(c.claimBand('kasia', 'K7P2')).toEqual({ ok: false, error: 'band-taken' });
    expect(c.claimBand('lukasz', 'AAAA')).toEqual({ ok: false, error: 'already-has-band' });
    expect(c.claimBand('nobody', 'BBBB')).toEqual({ ok: false, error: 'unknown-guest' });
  });

  it('host release frees the band for someone else', () => {
    const c = new Collect(guests);
    c.claimBand('lukasz', 'K7P2');
    c.releaseBand('k7p2');
    expect(c.bandOf('lukasz')).toBeUndefined();
    expect(c.claimBand('kasia', 'K7P2')).toEqual({ ok: true, changed: true });
  });
});

describe('scanning', () => {
  it('gives 10 base points, +10 other country, +10 other side', () => {
    const c = setup();
    expect(c.scan('lukasz', 'K002', 0)).toMatchObject({ ok: true, points: 10, bonuses: [] });
    expect(c.scan('lukasz', 'J003', 1)).toMatchObject({
      ok: true,
      points: 20,
      bonuses: ['other-country'],
    });
    expect(c.scan('lukasz', 'M005', 2)).toMatchObject({
      ok: true,
      points: 20,
      bonuses: ['other-side'],
    });
    expect(c.scan('lukasz', 'J004', 3)).toMatchObject({
      ok: true,
      points: 30,
      bonuses: ['other-country', 'other-side'],
      target: { id: 'jordi' },
    });
  });

  it('counts each person once per collector, but both can collect each other', () => {
    const c = setup();
    c.scan('lukasz', 'J004', 0);
    expect(c.scan('lukasz', 'j004', 1)).toEqual({ ok: false, error: 'already-collected' });
    expect(c.scan('jordi', 'L001', 2)).toMatchObject({ ok: true, points: 30 });
  });

  it('rejects your own band, unknown bands and unknown collectors', () => {
    const c = setup();
    expect(c.scan('lukasz', 'L001', 0)).toEqual({ ok: false, error: 'self' });
    expect(c.scan('lukasz', 'ZZZZ', 0)).toEqual({ ok: false, error: 'unknown-band' });
    expect(c.scan('lukasz', 'no spaces!', 0)).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.scan('nobody', 'L001', 0)).toEqual({ ok: false, error: 'unknown-guest' });
  });

  it('a released band can no longer be scanned', () => {
    const c = setup();
    c.releaseBand('J004');
    expect(c.scan('lukasz', 'J004', 0)).toEqual({ ok: false, error: 'unknown-band' });
  });

  it('rate-limits successful scans per collector within the window', () => {
    const extra: Record<string, Guest> = { ...guests };
    for (let i = 0; i < COLLECT_RATE_MAX + 2; i++) {
      extra[`g${i}`] = { id: `g${i}`, name: `G${i}`, country: 'PL', side: 'bride' };
    }
    const c = new Collect(extra);
    for (let i = 0; i < COLLECT_RATE_MAX + 2; i++) c.claimBand(`g${i}`, `B${i}`);

    for (let i = 0; i < COLLECT_RATE_MAX; i++) {
      expect(c.scan('lukasz', `B${i}`, i * 1_000).ok).toBe(true);
    }
    expect(c.scan('lukasz', `B${COLLECT_RATE_MAX}`, 10_000)).toEqual({
      ok: false,
      error: 'rate-limited',
    });
    // other collectors aren't affected
    expect(c.scan('kasia', 'B0', 10_000).ok).toBe(true);
    // once the oldest scan leaves the window, one more is allowed
    expect(c.scan('lukasz', `B${COLLECT_RATE_MAX}`, COLLECT_RATE_WINDOW_MS).ok).toBe(true);
  });
});

describe('leaderboard and stats', () => {
  it('ranks by points, then by number of people; ties share a rank', () => {
    const c = setup();
    c.scan('lukasz', 'J004', 0); // 30
    c.scan('kasia', 'J003', 0); // 20
    c.scan('kasia', 'L001', 1); // 10 → 30 with 2 people
    c.scan('marta', 'J004', 0); // 20 (other country, same side)
    c.scan('jurgen', 'M005', 0); // 30
    expect(c.ranking().map((r) => [r.id, r.points, r.people, r.rank])).toEqual([
      ['kasia', 30, 2, 1],
      ['jurgen', 30, 1, 2],
      ['lukasz', 30, 1, 2],
      ['marta', 20, 1, 4],
    ]);
  });

  it('counts cross-family scans and country pairs', () => {
    const c = setup();
    c.scan('lukasz', 'J004', 0); // PL bride → ES groom
    c.scan('jordi', 'L001', 0); // ES groom → PL bride
    c.scan('lukasz', 'K002', 1); // same country, same side
    c.scan('jurgen', 'K002', 0); // DE bride → PL bride
    expect(c.stats()).toEqual({ scans: 4, crossSide: 2, countryPairs: { 'ES+PL': 2, 'DE+PL': 1 } });
  });

  it('survives a JSON snapshot', () => {
    const c = setup();
    c.scan('lukasz', 'J004', 0);
    const restored = new Collect(guests, JSON.parse(JSON.stringify(c.state)) as CollectState);
    expect(restored.scan('lukasz', 'J004', 1)).toEqual({ ok: false, error: 'already-collected' });
    expect(restored.ranking()[0]).toMatchObject({ id: 'lukasz', points: 30 });
  });
});

describe('robustness', () => {
  it('ignores inherited object keys as guest ids and band codes', () => {
    const c = setup();
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(c.claimBand(id, 'CCCC')).toEqual({ ok: false, error: 'unknown-guest' });
      expect(c.scan(id, 'J004', 0)).toEqual({ ok: false, error: 'unknown-guest' });
    }
    expect(c.scan('lukasz', 'constructor', 0)).toEqual({ ok: false, error: 'unknown-band' });
    expect(c.scan('lukasz', '__proto__', 0)).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.ranking()).toEqual([]);
    expect(Object.keys(c.state.scans)).not.toContain('undefined');
  });

  it('rejects codes that are too long or not letters and digits', () => {
    const c = new Collect(guests);
    expect(c.claimBand('lukasz', 'A'.repeat(17))).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.claimBand('lukasz', 'A'.repeat(5_000_000))).toEqual({
      ok: false,
      error: 'invalid-code',
    });
    expect(c.claimBand('lukasz', 'K7-P2')).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.claimBand('lukasz', 42)).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.state.bands).toEqual({});
  });

  it('with the printed code list, made-up codes are refused', () => {
    const c = new Collect(guests, undefined, new Set(['K7P2', 'X9Q4']));
    expect(c.claimBand('lukasz', 'AAAA')).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.claimBand('lukasz', 'k7p2')).toEqual({ ok: true, changed: true });
    expect(c.scan('kasia', 'AAAA', 0)).toEqual({ ok: false, error: 'invalid-code' });
    expect(c.scan('kasia', 'K7P2', 0)).toMatchObject({ ok: true });
  });

  it('wrong codes count towards a limit, so codes cannot be guessed', () => {
    const c = setup();
    for (let i = 0; i < COLLECT_FAILED_MAX; i++) {
      expect(c.scan('lukasz', `ZZ${i}`, i)).toEqual({ ok: false, error: 'unknown-band' });
    }
    expect(c.scan('lukasz', 'J004', 100)).toEqual({ ok: false, error: 'rate-limited' });
    expect(c.scan('lukasz', 'J004', COLLECT_RATE_WINDOW_MS + 100)).toMatchObject({ ok: true });
  });
});

describe('camera re-scans and guest ids', () => {
  it('scanning the same real band over and over never locks the guest out', () => {
    const c = setup();
    c.scan('lukasz', 'J004', 0);
    for (let i = 1; i <= 100; i++) {
      expect(c.scan('lukasz', 'J004', i)).toEqual({ ok: false, error: 'already-collected' });
      expect(c.scan('lukasz', 'L001', i)).toEqual({ ok: false, error: 'self' });
    }
    expect(c.scan('lukasz', 'K002', 200)).toMatchObject({ ok: true });
  });

  it('refuses a guest list with unsafe or mismatched ids', () => {
    const proto = JSON.parse(
      '{"__proto__": {"id": "__proto__", "name": "x", "country": "PL", "side": "bride"}}',
    ) as Record<string, Guest>;
    expect(() => new Collect(proto)).toThrow(/Invalid guest id/);
    expect(() => new Collect({ a: { id: 'b', name: 'x', country: 'PL', side: 'bride' } })).toThrow(
      /Invalid guest id/,
    );
  });
});

describe('restoreCollectState', () => {
  it('restores a saved state', () => {
    const c = setup();
    c.scan('lukasz', 'J004', 0);
    c.scan('lukasz', 'nope', 1);
    const restored = restoreCollectState(JSON.parse(JSON.stringify(c.state)));
    expect(restored).toEqual(c.state);
  });

  it('accepts a snapshot without rate-limit history', () => {
    expect(restoreCollectState({ bands: { K7P2: 'lukasz' }, scans: {} })).toEqual({
      bands: { K7P2: 'lukasz' },
      scans: {},
      recent: {},
      failed: {},
    });
  });

  it('rejects broken snapshots', () => {
    expect(() => restoreCollectState(null)).toThrow(/Invalid snapshot/);
    expect(() => restoreCollectState({ scans: {} })).toThrow(/bands/);
    expect(() => restoreCollectState({ bands: { 'k7-p2': 'lukasz' }, scans: {} })).toThrow(/bands/);
    expect(() =>
      restoreCollectState(JSON.parse('{"bands": {}, "scans": {"__proto__": {}}}')),
    ).toThrow(/scans/);
    expect(() => restoreCollectState({ bands: {}, scans: { lukasz: { jordi: 'x' } } })).toThrow(
      /scans/,
    );
    expect(() => restoreCollectState({ bands: {}, scans: {}, recent: { lukasz: ['x'] } })).toThrow(
      /recent/,
    );
  });
});
