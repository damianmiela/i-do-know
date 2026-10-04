// Translation review (Phase 9). Run from the project root (PowerShell or any shell):
//
//   npm run texts:export
//     writes content/review/ui-texts.csv (the phone's and the big screen's texts) and
//     content/review/questions.csv (every question and answer). Both open in Google Sheets or
//     Excel; reviewers fill in the "XX fixed" column of their language, only where the draft is
//     wrong. content/ is git-ignored: the question sheet holds the real questions.
//
//   npm run texts:import -- content/review/questions.csv
//     puts the "fixed" cells of a returned question sheet into content/questions.json (checked
//     like at startup; the file before is kept as questions.prev.json). Stop the server first:
//     a running server keeps its own copy and would write it back.
//
// The UI sheet comes back to Claude, who applies it to the TypeScript text files.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = join(root, 'content');
const reviewDir = join(contentDir, 'review');

// Vite loads the TypeScript sources as they are (the same files the app is built from)
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
const load = (file) => vite.ssrLoadModule(join(root, file));

try {
  const [command, file] = process.argv.slice(2);
  const tr = await load('apps/server/src/translations.ts');
  const { loadQuestions } = await load('apps/server/src/content.ts');

  if (command === 'export') {
    const phone = await load('apps/client/src/i18n.ts');
    const screen = await load('apps/client/src/screen/texts.ts');
    mkdirSync(reviewDir, { recursive: true });
    const ui = [
      tr.UI_HEADER,
      ...tr.uiRows('Phone', phone.MESSAGES),
      ...tr.uiRows('Big screen', screen.MESSAGES),
    ];
    writeFileSync(join(reviewDir, 'ui-texts.csv'), tr.toCsv(ui));
    console.log(`content/review/ui-texts.csv: ${ui.length - 1} texts`);
    const q = loadQuestions(contentDir);
    if (q.isExample) {
      console.log('No content/questions.json yet: no question sheet (only the example exists).');
    } else {
      const lists = { questions: q.items, warmup: q.warmup ?? [], sets: q.sets };
      const rows = [tr.QUESTION_HEADER, ...tr.questionRows(lists)];
      writeFileSync(join(reviewDir, 'questions.csv'), tr.toCsv(rows));
      console.log(
        `content/review/questions.csv: ${rows.length - 1} texts (private: never share it publicly)`,
      );
    }
  } else if (command === 'import' && file) {
    const q = loadQuestions(contentDir);
    if (q.isExample) throw new Error('There is no content/questions.json to put the fixes into.');
    const lists = { questions: q.items, warmup: q.warmup ?? [], sets: q.sets };
    const table = tr.parseCsv(readFileSync(resolve(file), 'utf8'));
    const { lists: next, changed, problems } = tr.applyQuestionFixes(lists, table);
    for (const p of problems) console.log(`Skipped: ${p}`);
    if (!changed) {
      console.log('Nothing to change (no "fixed" cell differs from the file).');
    } else {
      const { validateQuestions } = await load('apps/server/src/game/quiz.ts');
      const errors = [
        ...validateQuestions(next.questions),
        ...validateQuestions(next.warmup).map((e) => `warm-up ${e}`),
        ...next.sets.flatMap((s) => validateQuestions(s.questions).map((e) => `${s.name}: ${e}`)),
      ];
      if (errors.length)
        throw new Error(`Not saved, the result has problems:\n- ${errors.join('\n- ')}`);
      const { QuestionWriter } = await load('apps/server/src/questionStore.ts');
      let failed;
      await new QuestionWriter(contentDir, (e) => (failed = e)).save(next, q.timeLimitSec);
      if (failed) throw failed;
      console.log(
        `${changed} text(s) changed in content/questions.json (the old file: questions.prev.json).`,
      );
    }
  } else {
    console.log('Use: npm run texts:export   or   npm run texts:import -- <file.csv>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await vite.close();
}
