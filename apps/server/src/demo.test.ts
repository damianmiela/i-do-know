import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoDirs, eventContentProblem, msUntilHour, setEventFlag, startupEnv } from './demo';

describe('the public demo', () => {
  it('plays with a fresh copy of the example content, never the real files', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const first = demoDirs(root);
    for (const f of ['questions', 'guests', 'event']) {
      expect(readFileSync(join(first.contentDir, `${f}.json`), 'utf8')).toBe(
        readFileSync(join(root, `content/${f}.example.json`), 'utf8'),
      );
    }
    expect(existsSync(join(first.contentDir, 'photos/example-baby.webp'))).toBe(true);
    expect(first.contentDir.startsWith(join(root, 'content'))).toBe(false);
    // the next start tidies the earlier copy away
    const second = demoDirs(root);
    expect(existsSync(first.contentDir)).toBe(false);
    rmSync(dirname(second.contentDir), { recursive: true, force: true });
  });

  it('resets at the next 4:00, at most a day later', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 3, h, m);
    expect(msUntilHour(at(3, 30), 4)).toBe(30 * 60_000);
    expect(msUntilHour(at(4, 0), 4)).toBe(24 * 3_600_000); // just reset: the next one tomorrow
    expect(msUntilHour(at(23, 0), 4)).toBe(5 * 3_600_000);
  });
});

describe('the switch to the real event at startup', () => {
  const root = resolve(import.meta.dirname, '../../..');
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ido-event-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it('plays the event only with the flag AND an event password; otherwise the demo', () => {
    const env = { DEMO_MODE: 'true', EVENT_DIR: dir, EVENT_PASSWORD: 'e'.repeat(16) };
    expect(startupEnv({}, root)).toEqual({}); // not a demo: nothing changes
    const demo = startupEnv(env, root);
    expect(demo.CONTENT_DIR).toContain('idoknow-demo-');
    rmSync(dirname(demo.CONTENT_DIR!), { recursive: true, force: true });
    setEventFlag(dir, true);
    expect(startupEnv(env, root)).toEqual({
      DEMO_MODE: 'false',
      EVENT_MODE: 'true',
      ADMIN_PASSWORD: 'e'.repeat(16),
      EVENT_PASSWORD: undefined,
      CONTENT_DIR: join(dir, 'content'),
      DATA_DIR: join(dir, 'data'),
    });
    const noPassword = startupEnv({ DEMO_MODE: 'true', EVENT_DIR: dir }, root);
    expect(noPassword.CONTENT_DIR).toContain('idoknow-demo-');
    rmSync(dirname(noPassword.CONTENT_DIR!), { recursive: true, force: true });
    setEventFlag(dir, false);
    expect(existsSync(join(dir, 'EVENT_MODE'))).toBe(false);
  });

  it('checks the event content before switching', () => {
    expect(eventContentProblem(dir)).toMatch(/questions\.json is missing/);
    mkdirSync(join(dir, 'content'));
    for (const f of ['questions', 'guests', 'event']) {
      copyFileSync(join(root, `content/${f}.example.json`), join(dir, `content/${f}.json`));
    }
    expect(eventContentProblem(dir)).toBeUndefined();
    writeFileSync(join(dir, 'content/guests.json'), '{ "guests": 5 }');
    expect(eventContentProblem(dir)).toMatch(/guests/);
  });
});
