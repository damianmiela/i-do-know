import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVENT_TITLE_MAX, loadEvent, loadGuests } from './content';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ido-content-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const write = (name: string, data: unknown) =>
  writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));

describe('the guest list', () => {
  it('writes accents one way (a Mac may save "ü" as "u" + a mark)', () => {
    const decomposed = 'Ju\u0308rgen Weiß'; // u + combining diaeresis
    writeFileSync(
      join(dir, 'guests.json'),
      JSON.stringify({ guests: [{ id: 'g1', name: decomposed, country: 'DE', side: 'groom' }] }),
    );
    const { items, isExample } = loadGuests(dir);
    expect(isExample).toBe(false);
    expect(items[0]!.name).toBe('Jürgen Weiß');
    expect(items[0]!.name).not.toBe(decomposed);
  });
});

const title = (en: string) => ({ pl: en, es: en, ca: en, de: en, en });
const EVENT = {
  title: title('Who knows Zofia & Xavi best?'),
  sides: { bride: 'Zofia', groom: 'Xavi' },
};

describe('content/event.json', () => {
  it('is loaded with only the known fields', () => {
    write('event.json', { ...EVENT, secret: 'x', sides: { ...EVENT.sides, extra: 1 } });
    expect(loadEvent(dir)).toEqual({ event: EVENT, notes: [] });
  });

  it('reads a file saved with a byte order mark (Windows PowerShell 5.1)', () => {
    write('event.json', '\uFEFF' + JSON.stringify(EVENT));
    expect(loadEvent(dir).event).toEqual(EVENT);
  });

  it('falls back to the example file with a setup note', () => {
    write('event.example.json', EVENT);
    const { event, notes } = loadEvent(dir);
    expect(event).toEqual(EVENT);
    expect(notes).toEqual(['content/event.json is missing: the EXAMPLE couple is in use']);
  });

  it('the example file in the repo is valid', () => {
    expect(() => loadEvent(join(import.meta.dirname, '../../../content'))).not.toThrow();
  });

  it('refuses a missing language, an empty side or a too long title', () => {
    write('event.json', {
      title: { ...EVENT.title, en: undefined },
      sides: { bride: ' ', groom: 'Xavi' },
    });
    expect(() => loadEvent(dir)).toThrow(/title\.en[\s\S]*sides\.bride/);
    write('event.json', { ...EVENT, title: title('x'.repeat(EVENT_TITLE_MAX + 1)) });
    expect(() => loadEvent(dir)).toThrow(/title\.pl/);
  });

  it('refuses broken JSON and a missing file', () => {
    write('event.json', '{ nope');
    expect(() => loadEvent(dir)).toThrow(/not valid JSON/);
    rmSync(join(dir, 'event.json'));
    expect(() => loadEvent(dir)).toThrow(/ENOENT/);
  });
});
