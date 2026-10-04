// The public demo (DEMO_MODE=true) and its switch to the real event.
//
// The demo never touches real files: every start copies the example content into a fresh temp
// folder, and the server ends itself once a day so Docker starts it fresh (the nightly reset).
//
// The real event lives in EVENT_DIR (content/, data/). Logging in with EVENT_PASSWORD writes the
// mode flag there and restarts the server: at startup the flag decides which ONE game this process
// plays. So the demo and the event are never in memory together; in event mode the demo password,
// the demo players and the nightly reset don't exist. "End the event" removes the flag and restarts.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEvent, loadGuests, loadQuestions } from './content';

/** The demo restarts (and so resets) at this hour, server time (UTC in Docker). */
export const DEMO_RESET_HOUR = 4;
const PREFIX = 'idoknow-demo-';

/** A fresh copy of the example content and an empty data folder; earlier runs' copies go. */
export function demoDirs(root: string): { contentDir: string; dataDir: string } {
  for (const old of readdirSync(tmpdir()).filter((d) => d.startsWith(PREFIX))) {
    rmSync(join(tmpdir(), old), { recursive: true, force: true });
  }
  const work = mkdtempSync(join(tmpdir(), PREFIX));
  const contentDir = join(work, 'content');
  mkdirSync(join(contentDir, 'photos'), { recursive: true });
  for (const name of ['questions', 'guests', 'event']) {
    copyFileSync(join(root, `content/${name}.example.json`), join(contentDir, `${name}.json`));
  }
  copyFileSync(
    join(root, 'content/photos/example-baby.webp'),
    join(contentDir, 'photos/example-baby.webp'),
  );
  return { contentDir, dataDir: join(work, 'data') };
}

/** Milliseconds from `now` until the next `hour`:00 (always in the future, at most a day). */
export function msUntilHour(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/** Ends the demo at the next reset hour (Docker's restart policy starts it fresh). */
export function scheduleDemoReset(restart: () => void): void {
  setTimeout(restart, msUntilHour(new Date(), DEMO_RESET_HOUR)).unref();
}

const flagOf = (eventDir: string) => join(eventDir, 'EVENT_MODE');

/** The event's folders: the real content and its own (kept) game data. */
export const eventContent = (eventDir: string) => join(eventDir, 'content');
export const eventData = (eventDir: string) => join(eventDir, 'data');

/** Turns event mode on (for the next start) or off. */
export function setEventFlag(eventDir: string, on: boolean): void {
  if (on) writeFileSync(flagOf(eventDir), `${new Date().toISOString()}\n`);
  else rmSync(flagOf(eventDir), { force: true });
}

/** Why the event's content can't be played (undefined: it loads). Checked before switching. */
export function eventContentProblem(eventDir: string): string | undefined {
  const dir = eventContent(eventDir);
  for (const f of ['questions.json', 'guests.json', 'event.json']) {
    if (!existsSync(join(dir, f))) return `${f} is missing in the event folder`;
  }
  try {
    loadQuestions(dir);
    loadGuests(dir);
    loadEvent(dir);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * At startup, with DEMO_MODE=true: the settings for the game this process plays. Event mode
 * (the flag is set and there is an event password): the real content, the event's password as the
 * only admin password, no demo. Otherwise the demo with a fresh copy of the example content.
 * `undefined` values are removed from the environment.
 */
export function startupEnv(
  env: Record<string, string | undefined>,
  root: string,
): Record<string, string | undefined> {
  if (env.DEMO_MODE !== 'true') return {};
  const eventDir = resolve(root, env.EVENT_DIR || 'event');
  if (env.EVENT_PASSWORD && existsSync(flagOf(eventDir))) {
    return {
      DEMO_MODE: 'false',
      EVENT_MODE: 'true',
      ADMIN_PASSWORD: env.EVENT_PASSWORD,
      EVENT_PASSWORD: undefined,
      CONTENT_DIR: eventContent(eventDir),
      DATA_DIR: eventData(eventDir),
    };
  }
  const dirs = demoDirs(root);
  return { CONTENT_DIR: dirs.contentDir, DATA_DIR: dirs.dataDir };
}
