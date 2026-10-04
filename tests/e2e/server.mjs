// The server for the browser tests: the production build with ONLY the example content, a
// throwaway admin password and temp folders (the real content/, data/ and .env are never used).
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
// Windows ends this process hard after the tests (no exit handler runs): tidy up earlier runs
for (const old of readdirSync(tmpdir()).filter((d) => d.startsWith('idoknow-e2e-'))) {
  rmSync(join(tmpdir(), old), { recursive: true, force: true });
}
const work = mkdtempSync(join(tmpdir(), 'idoknow-e2e-'));
const content = join(work, 'content');
mkdirSync(join(content, 'photos'), { recursive: true });
for (const f of ['questions', 'guests', 'event']) {
  copyFileSync(join(root, `content/${f}.example.json`), join(content, `${f}.json`));
}
copyFileSync(
  join(root, 'content/photos/example-baby.webp'),
  join(content, 'photos/example-baby.webp'),
);

Object.assign(process.env, {
  ADMIN_PASSWORD: process.env.E2E_PASSWORD,
  SESSION_SECRET: 'e2e-session-secret-'.repeat(3),
  PORT: process.env.E2E_PORT,
  HOST: '127.0.0.1',
  CONTENT_DIR: content,
  DATA_DIR: join(work, 'data'),
});
process.on('exit', () => rmSync(work, { recursive: true, force: true }));
await import('../../apps/server/dist/index.js');
