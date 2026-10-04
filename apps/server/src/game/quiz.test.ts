import { readFileSync } from 'node:fs';
import { missingLangs, type Localized } from '@idoknow/shared';
import { describe, expect, it } from 'vitest';
import {
  initialQuizState,
  pointsFor,
  Quiz,
  restoreQuizState,
  validateQuestions,
  incomplete,
  tidyQuestions,
  type Question,
  type QuizState,
} from './quiz';

const t = (en: string): Localized => ({ pl: en, es: en, ca: en, de: en, en });
const q = (id: string, extra: Partial<Question> = {}): Question => ({
  id,
  kind: 'choice',
  text: t(id),
  options: [t('a'), t('b'), t('c'), t('d')],
  correct: 1,
  ...extra,
});

function setup(questions: Question[] = [q('q1'), q('q2'), q('q3')]) {
  const quiz = new Quiz(questions, undefined, false, 20);
  quiz.addPlayer('ann', 'Ann');
  quiz.addPlayer('bob', 'Bob');
  quiz.addPlayer('cid', 'Cid');
  return quiz;
}

describe('reading time (Phase 9.5)', () => {
  it('opens the question with the clock still; showAnswers starts it from full', () => {
    const quiz = setup();
    quiz.start(0, true);
    expect(quiz.state.reading).toBe(true);
    expect(quiz.timeLeftMs(50_000)).toBe(20_000);
    expect(quiz.answer('ann', 1, 1_000)).toEqual({ ok: false, error: 'wrong-phase' });
    expect(quiz.next(1_000)).toEqual({ ok: false, error: 'wrong-phase' });
    expect(quiz.resume(1_000)).toEqual({ ok: false, error: 'wrong-phase' });
    expect(quiz.showAnswers(60_000)).toEqual({ ok: true });
    expect(quiz.showAnswers(60_000)).toEqual({ ok: false, error: 'wrong-phase' });
    expect(quiz.timeLeftMs(62_000)).toBe(18_000);
    expect(quiz.answer('ann', 1, 61_000)).toEqual({ ok: true });
    expect(quiz.state.answers.ann?.elapsedMs).toBe(1_000);
    quiz.next(70_000); // reveal
    expect(quiz.state.reading).toBeUndefined();
    quiz.next(70_000); // Top 10
    quiz.next(80_000, false); // switched off: straight to the answers
    expect(quiz.state.reading).toBeUndefined();
    expect(quiz.timeLeftMs(81_000)).toBe(19_000);
  });

  it('a snapshot keeps the reading time; a broken flag outside a question is dropped', () => {
    const quiz = setup();
    quiz.start(0, true);
    expect(restoreQuizState(JSON.parse(JSON.stringify(quiz.state))).reading).toBe(true);
    const lobby = { ...(JSON.parse(JSON.stringify(setup().state)) as object), reading: true };
    expect(restoreQuizState(lobby).reading).toBeUndefined();
  });
});

describe('pointsFor', () => {
  it('drops linearly from 1000 to 500 over the countdown', () => {
    expect(pointsFor(0, 20_000)).toBe(1000);
    expect(pointsFor(10_000, 20_000)).toBe(750);
    expect(pointsFor(20_000, 20_000)).toBe(500);
    expect(pointsFor(5_100, 20_000)).toBe(873);
  });
  it('clamps out-of-range times', () => {
    expect(pointsFor(-50, 20_000)).toBe(1000);
    expect(pointsFor(99_000, 20_000)).toBe(500);
  });
});

describe('Quiz flow', () => {
  it('scores correct answers by speed, wrong and missing answers get 0', () => {
    const quiz = setup();
    expect(quiz.start(0)).toEqual({ ok: true });
    expect(quiz.answer('ann', 1, 5_100)).toEqual({ ok: true }); // correct, 5.1 s
    expect(quiz.answer('bob', 2, 1_000)).toEqual({ ok: true }); // wrong
    quiz.next(15_000); // reveal (cid never answered)
    expect(quiz.state.phase).toBe('reveal');
    expect(quiz.state.lastPoints).toEqual({ ann: 873, bob: 0, cid: 0 });
    expect(quiz.state.players.ann).toMatchObject({
      score: 873,
      correctCount: 1,
      correctTimeMs: 5_100,
    });
    expect(quiz.state.players.bob).toMatchObject({ score: 0, correctCount: 0 });
  });

  it('goes question → reveal → Top 10 → question … → reveal → final', () => {
    const quiz = setup([q('q1'), q('q2')]);
    quiz.start(0);
    quiz.next(1);
    expect(quiz.state.phase).toBe('reveal');
    quiz.next(2);
    expect(quiz.state.phase).toBe('leaderboard');
    quiz.next(3);
    expect(quiz.state).toMatchObject({ phase: 'question', index: 1, startedAt: 3, answers: {} });
    quiz.next(4);
    quiz.next(5); // after the last question: straight to the podium, no Top 10
    expect(quiz.state.phase).toBe('final');
    expect(quiz.next(6)).toEqual({ ok: false, error: 'wrong-phase' });
  });

  it('ignores leaderboardAfter in an old questions.json (the Top 10 comes after every question)', () => {
    const old = { ...q('q1'), leaderboardAfter: false } as Question;
    expect(validateQuestions([old])).toEqual([]);
  });

  it('refuses to start twice or with no questions', () => {
    const quiz = setup();
    quiz.start(0);
    expect(quiz.start(1)).toEqual({ ok: false, error: 'wrong-phase' });
    expect(new Quiz([]).start(0)).toEqual({ ok: false, error: 'no-questions' });
  });
});

describe('Quiz answers', () => {
  it('rejects answers outside a question, from unknown players and invalid options', () => {
    const quiz = setup();
    expect(quiz.answer('ann', 1, 0)).toEqual({ ok: false, error: 'wrong-phase' });
    quiz.start(0);
    expect(quiz.answer('zed', 1, 1)).toEqual({ ok: false, error: 'unknown-player' });
    expect(quiz.answer('ann', 4, 1)).toEqual({ ok: false, error: 'invalid-option' });
    expect(quiz.answer('ann', -1, 1)).toEqual({ ok: false, error: 'invalid-option' });
    expect(quiz.answer('ann', 1.5, 1)).toEqual({ ok: false, error: 'invalid-option' });
  });

  it('respects the number of options (bride or groom has 2)', () => {
    const quiz = setup([
      q('bg', { kind: 'bride-or-groom', options: [t('Anna'), t('Ben')], correct: 0 }),
    ]);
    quiz.start(0);
    expect(quiz.answer('ann', 2, 1)).toEqual({ ok: false, error: 'invalid-option' });
    expect(quiz.answer('ann', 0, 1)).toEqual({ ok: true });
  });

  it('locks the first answer', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 0, 1_000);
    expect(quiz.answer('ann', 1, 2_000)).toEqual({ ok: false, error: 'already-answered' });
    expect(quiz.state.answers.ann).toEqual({ option: 0, elapsedMs: 1_000, limitMs: 20_000 });
  });

  it('accepts late taps within the 2 s grace, at the minimum points', () => {
    const quiz = setup();
    quiz.start(0);
    expect(quiz.timeLeftMs(20_500)).toBe(0); // the countdown itself still ends at 20 s
    expect(quiz.answer('ann', 1, 20_000)).toEqual({ ok: true });
    expect(quiz.answer('bob', 1, 21_999)).toEqual({ ok: true });
    quiz.next(22_000);
    expect(quiz.state.lastPoints).toMatchObject({ ann: 500, bob: 500 });
  });

  it('rejects answers after the countdown plus grace', () => {
    const quiz = setup();
    quiz.start(0);
    expect(quiz.answer('bob', 1, 22_000)).toEqual({ ok: false, error: 'time-up' });
  });

  it('refuses answers while paused, even inside the grace', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.pause(20_500);
    expect(quiz.answer('ann', 1, 20_600)).toEqual({ ok: false, error: 'paused' });
  });

  it('never records a negative answer time', () => {
    const quiz = setup();
    quiz.start(5_000);
    quiz.answer('ann', 1, 4_990);
    expect(quiz.state.answers.ann?.elapsedMs).toBe(0);
  });

  it("one countdown for every question: the host's, 60 s unless set", () => {
    const quiz = new Quiz([q('q1'), q('q2')]);
    quiz.start(0);
    expect(quiz.limitMs()).toBe(60_000);
    expect(quiz.publicQuestion()?.timeLimitSec).toBe(60);
    const short = new Quiz([q('q1')], undefined, false, 15);
    short.start(0);
    expect(short.limitMs()).toBe(15_000);
    // the points still go by the share of the countdown used: half of 15 s = 750
    short.addPlayer('ann', 'Ann');
    short.answer('ann', 1, 7_500);
    short.next(8_000);
    expect(short.state.players.ann?.score).toBe(750);
  });
});

describe('removePlayer', () => {
  it('takes a player off every list', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 1_000);
    quiz.next(2_000);
    quiz.removePlayer('ann');
    const s = quiz.state;
    expect([s.players, s.answers, s.lastPoints, s.prevRanks].some((r) => 'ann' in r)).toBe(false);
    quiz.removePlayer('nobody'); // no error
  });
});

describe('Host controls', () => {
  it('pause freezes the countdown and blocks answers; resume continues', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.pause(5_000);
    expect(quiz.timeLeftMs(60_000)).toBe(15_000);
    expect(quiz.answer('ann', 1, 6_000)).toEqual({ ok: false, error: 'paused' });
    expect(quiz.pause(6_000)).toEqual({ ok: false, error: 'wrong-phase' });
    quiz.resume(65_000); // paused for 60 s
    expect(quiz.timeLeftMs(65_000)).toBe(15_000);
    quiz.answer('ann', 1, 75_000); // 15 s of real countdown
    expect(quiz.state.answers.ann?.elapsedMs).toBe(15_000);
    expect(quiz.resume(76_000)).toEqual({ ok: false, error: 'wrong-phase' });
  });

  it('+10 s extends the countdown', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.addTime(10_000);
    expect(quiz.timeLeftMs(20_000)).toBe(10_000);
    expect(quiz.answer('ann', 1, 25_000)).toEqual({ ok: true });
    quiz.next(26_000);
    expect(quiz.state.lastPoints.ann).toBe(pointsFor(25_000, 30_000));
  });

  it('revealing early closes the question', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.next(3_000);
    expect(quiz.answer('ann', 1, 3_500)).toEqual({ ok: false, error: 'wrong-phase' });
  });

  it('skip gives nobody points and moves on; skipping the last question ends the quiz', () => {
    const quiz = setup([q('q1'), q('q2')]);
    quiz.start(0);
    quiz.answer('ann', 1, 1_000);
    quiz.skip(2_000);
    expect(quiz.state).toMatchObject({ phase: 'question', index: 1, answers: {} });
    expect(quiz.state.players.ann?.score).toBe(0);
    quiz.skip(3_000);
    expect(quiz.state.phase).toBe('final');
    expect(quiz.skip(4_000)).toEqual({ ok: false, error: 'wrong-phase' });
  });

  it('restart resets scores but keeps players', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 1_000);
    quiz.next(2_000);
    quiz.restart();
    expect(quiz.state.phase).toBe('lobby');
    expect(quiz.state.index).toBe(-1);
    expect(Object.keys(quiz.state.players)).toEqual(['ann', 'bob', 'cid']);
    expect(quiz.state.players.ann?.score).toBe(0);
  });
});

describe('Players', () => {
  it('re-adding a player keeps their score (reconnect)', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 0);
    quiz.next(1);
    quiz.addPlayer('ann', 'Ann again');
    expect(quiz.state.players.ann).toMatchObject({ name: 'Ann', score: 1000 });
  });

  it('late joiners can answer the current question and score from then on', () => {
    const quiz = setup([q('q1'), q('q2')]);
    quiz.start(0);
    quiz.next(1); // q1 revealed without dan
    quiz.addPlayer('dan', 'Dan');
    expect(quiz.state.players.dan?.score).toBe(0);
    quiz.next(2); // Top 10
    quiz.next(2); // q2 opens
    expect(quiz.answer('dan', 1, 2)).toEqual({ ok: true });
    quiz.next(3);
    expect(quiz.state.players.dan?.score).toBe(1000);
  });
});

describe('ranking', () => {
  it('sorts by score, then by lower total time of correct answers', () => {
    const quiz = setup();
    quiz.state.players.ann = {
      id: 'ann',
      name: 'Ann',
      score: 1500,
      correctCount: 2,
      correctTimeMs: 9_000,
    };
    quiz.state.players.bob = {
      id: 'bob',
      name: 'Bob',
      score: 1500,
      correctCount: 2,
      correctTimeMs: 8_000,
    };
    quiz.state.players.cid = {
      id: 'cid',
      name: 'Cid',
      score: 2000,
      correctCount: 2,
      correctTimeMs: 0,
    };
    expect(quiz.ranking().map((p) => [p.id, p.rank])).toEqual([
      ['cid', 1],
      ['bob', 2],
      ['ann', 3],
    ]);
  });

  it('gives a shared rank only when score and time are identical', () => {
    const quiz = setup();
    quiz.state.players.ann = {
      id: 'ann',
      name: 'Ann',
      score: 900,
      correctCount: 1,
      correctTimeMs: 4_000,
    };
    quiz.state.players.bob = {
      id: 'bob',
      name: 'Bob',
      score: 900,
      correctCount: 1,
      correctTimeMs: 4_000,
    };
    expect(quiz.ranking().map((p) => [p.id, p.rank])).toEqual([
      ['ann', 1],
      ['bob', 1],
      ['cid', 3],
    ]);
  });

  it('remembers ranks from before each reveal, for "▲ 3 places"', () => {
    const quiz = setup([q('q1'), q('q2')]);
    quiz.start(0);
    quiz.answer('ann', 1, 0);
    quiz.next(1); // ann 1st
    quiz.next(2); // Top 10
    quiz.next(2);
    quiz.answer('cid', 1, 0);
    quiz.answer('bob', 1, 1_000);
    quiz.next(3);
    expect(quiz.state.prevRanks).toEqual({ ann: 1, bob: 2, cid: 2 });
    expect(quiz.ranking().map((p) => [p.id, p.rank])).toEqual([
      ['ann', 1],
      ['cid', 1],
      ['bob', 3],
    ]);
  });
});

describe('places before the first points', () => {
  it('after the first question nobody moved (everyone was tied at 0)', () => {
    const quiz = setup([q('q1'), q('q2')]);
    quiz.start(0);
    quiz.answer('bob', 1, 1_000);
    quiz.next(2); // reveal q1: bob 1st, ann and cid behind
    expect(quiz.state.prevRanks).toEqual({});
    quiz.next(3);
    quiz.next(4); // q2
    quiz.answer('ann', 1, 0);
    quiz.next(5); // reveal q2: now there were places before
    expect(quiz.state.prevRanks).toEqual({ bob: 1, ann: 2, cid: 2 });
  });
});

describe('snapshot', () => {
  it('continues from a JSON snapshot exactly where it was', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 2_000);
    const saved = JSON.parse(JSON.stringify(quiz.state)) as QuizState;

    const restored = new Quiz(quiz.questions, saved, false, 20);
    expect(restored.answer('ann', 0, 3_000)).toEqual({ ok: false, error: 'already-answered' });
    restored.answer('bob', 1, 4_000);
    restored.next(5_000);
    expect(restored.state.lastPoints).toEqual({ ann: 950, bob: 900, cid: 0 });
  });
});

describe('answer log (Phase 6.8)', () => {
  it('keeps every answer of every question, with points; a skip keeps its answers at 0', () => {
    const quiz = setup();
    quiz.start(1_000);
    quiz.answer('ann', 1, 3_000);
    quiz.answer('bob', 0, 5_000);
    quiz.next(6_000); // reveal q1
    quiz.next(6_000); // Top 10
    quiz.next(7_000); // q2
    quiz.answer('cid', 1, 8_000);
    quiz.skip(9_000); // q3
    expect(quiz.state.log).toEqual([
      {
        questionId: 'q1',
        openedAt: 1_000,
        skipped: false,
        answers: {
          ann: { option: 1, elapsedMs: 2_000, points: 950 },
          bob: { option: 0, elapsedMs: 4_000, points: 0 },
        },
      },
      {
        questionId: 'q2',
        openedAt: 7_000,
        skipped: true,
        answers: { cid: { option: 1, elapsedMs: 1_000, points: 0 } },
      },
    ]);
    // it survives a snapshot, and a restart starts a new log
    const saved = restoreQuizState(JSON.parse(JSON.stringify(quiz.state)));
    expect(saved.log).toEqual(quiz.state.log);
    quiz.restart();
    expect(quiz.state.log).toEqual([]);
  });

  it('snapshots from before the log load with an empty one; a broken log is refused', () => {
    const old: Partial<QuizState> = initialQuizState();
    delete old.log;
    expect(restoreQuizState(old).log).toEqual([]);
    expect(() => restoreQuizState({ ...old, log: [{ questionId: 'q1' }] })).toThrow(/log 0/);
    const bad = { questionId: 'q1', openedAt: 1, skipped: false, answers: { a: { option: 'x' } } };
    expect(() => restoreQuizState({ ...old, log: [bad] })).toThrow(/log 0 answers/);
  });
});

describe('active players (auto-reveal, Phase 6.9)', () => {
  it('everyone counts at first; later only who answered one of the last 2 questions', () => {
    const quiz = new Quiz([q('q1'), q('q2'), q('q3'), q('q4')], undefined, false, 20);
    for (const id of ['ann', 'bob', 'cid']) quiz.addPlayer(id, id);
    const play = (at: number, who: string[]) => {
      if (quiz.state.phase === 'leaderboard') quiz.next(at);
      for (const id of who) quiz.answer(id, 1, at + 100);
      return quiz.everyoneAnswered();
    };
    quiz.start(0);
    expect(quiz.everyoneAnswered()).toBe(false); // nobody yet
    expect(play(0, ['ann', 'bob'])).toBe(false); // cid still counts on question 1
    quiz.next(1_000);
    quiz.next(1_000);
    expect(play(2_000, ['ann', 'bob'])).toBe(false); // …and on question 2
    quiz.next(3_000);
    quiz.next(3_000);
    // question 3: cid answered none of the last 2 → no longer holds up the reveal
    expect(quiz.activePlayers().sort()).toEqual(['ann', 'bob']);
    // a guest who joins now counts for their first 2 questions
    quiz.addPlayer('dan', 'dan');
    expect(play(4_000, ['ann', 'bob'])).toBe(false);
    quiz.answer('dan', 0, 4_500);
    expect(quiz.everyoneAnswered()).toBe(true);
  });

  it('after questions nobody answered, everyone counts again (audit 9)', () => {
    const quiz = new Quiz([q('q1'), q('q2'), q('q3')], undefined, false, 20);
    for (const id of ['ann', 'bob', 'cid']) quiz.addPlayer(id, id);
    quiz.start(0);
    quiz.next(1_000); // reveal q1, nobody answered
    quiz.next(1_000);
    quiz.next(2_000); // q2
    quiz.next(3_000); // reveal q2, nobody answered
    quiz.next(3_000);
    quiz.next(4_000); // q3
    expect(quiz.activePlayers().sort()).toEqual(['ann', 'bob', 'cid']);
    quiz.answer('ann', 1, 4_100);
    expect(quiz.everyoneAnswered()).toBe(false);
  });

  it('removing a player also takes their answers out of the log', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 100);
    quiz.next(1_000);
    quiz.removePlayer('ann');
    expect(quiz.state.log[0]!.answers).toEqual({});
    expect(quiz.state.players.ann).toBeUndefined();
  });
});

describe('robustness', () => {
  it('ignores inherited object keys as player ids', () => {
    const quiz = setup();
    quiz.start(0);
    expect(quiz.addPlayer('__proto__', 'x')).toEqual({ ok: false, error: 'invalid-player' });
    expect(quiz.addPlayer('', 'x')).toEqual({ ok: false, error: 'invalid-player' });
    expect(quiz.addPlayer('x'.repeat(65), 'x')).toEqual({ ok: false, error: 'invalid-player' });
    for (const id of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(quiz.answer(id, 1, 1)).toEqual({ ok: false, error: 'unknown-player' });
    }
    expect(Object.getPrototypeOf(quiz.state.players)).toBe(Object.prototype);
  });

  it('rejects bad "+time" values', () => {
    const quiz = setup();
    quiz.start(0);
    for (const ms of [NaN, Infinity, -1e9, 0, 1.5, 60_001]) {
      expect(quiz.addTime(ms)).toEqual({ ok: false, error: 'invalid-time' });
    }
    expect(quiz.limitMs()).toBe(20_000);
    // at most 10 minutes of extra time per question in total (audit 9)
    for (let i = 0; i < 10; i++) expect(quiz.addTime(60_000)).toEqual({ ok: true });
    expect(quiz.addTime(1_000)).toEqual({ ok: false, error: 'invalid-time' });
    expect(quiz.limitMs()).toBe(620_000);
  });

  it('"+time" does not change points of answers already given', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 19_000); // 525 points on a 20 s countdown
    quiz.addTime(30_000);
    quiz.answer('bob', 1, 25_000);
    quiz.next(26_000);
    expect(quiz.state.lastPoints.ann).toBe(525);
    expect(quiz.state.lastPoints.bob).toBe(pointsFor(25_000, 50_000));
  });

  it('a clock jumping backwards during a pause does not shorten the countdown', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.pause(10_000);
    quiz.resume(5_000);
    expect(quiz.timeLeftMs(10_000)).toBe(10_000);
  });

  it('never sends the correct answer in the public question', () => {
    const quiz = setup();
    expect(quiz.publicQuestion()).toBeUndefined();
    quiz.start(0);
    const pub = quiz.publicQuestion();
    expect(pub).toMatchObject({ id: 'q1', kind: 'choice', timeLimitSec: 20 });
    expect(pub).not.toHaveProperty('correct');
    expect(JSON.stringify(pub)).not.toContain('correct');
  });
});

describe('more host and join paths', () => {
  it('a player who joins mid-question can still answer it', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.addPlayer('dan', 'Dan');
    expect(quiz.answer('dan', 1, 4_000)).toEqual({ ok: true });
  });

  it('a player who joins after a reveal has no result for it (phone shows "wait")', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.next(1);
    quiz.addPlayer('dan', 'Dan');
    expect(quiz.state.lastPoints.dan).toBeUndefined();
    expect(quiz.state.prevRanks.dan).toBeUndefined();
  });

  it('pause then reveal, and pause then skip, both leave no pause behind', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.pause(1_000);
    quiz.next(2_000);
    expect(quiz.state).toMatchObject({ phase: 'reveal', pausedAt: null });
    quiz.next(3_000); // Top 10
    quiz.next(3_000);
    quiz.pause(4_000);
    quiz.skip(5_000);
    expect(quiz.state).toMatchObject({ phase: 'question', index: 2, pausedAt: null, pausedMs: 0 });
  });

  it('"+time" works while paused', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.pause(5_000);
    quiz.addTime(10_000);
    quiz.resume(8_000);
    expect(quiz.timeLeftMs(8_000)).toBe(25_000);
  });

  it('restart in the middle of a question gives a clean lobby and can start again', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 1_000);
    quiz.pause(2_000);
    quiz.restart();
    expect(quiz.state).toMatchObject({ phase: 'lobby', index: -1, questionId: null, answers: {} });
    expect(quiz.start(10_000)).toEqual({ ok: true });
    expect(quiz.state).toMatchObject({
      phase: 'question',
      index: 0,
      startedAt: 10_000,
      pausedAt: null,
    });
  });
});

describe('question validation', () => {
  it('accepts the example questions file', () => {
    const file = JSON.parse(
      readFileSync(new URL('../../../../content/questions.example.json', import.meta.url), 'utf8'),
    ) as { questions: Question[] };
    expect(validateQuestions(file.questions)).toEqual([]);
    expect(() => new Quiz(file.questions)).not.toThrow();
  });

  it('reports every kind of mistake', () => {
    const good = q('ok');
    const bad = [
      { ...good, id: '' },
      { ...good, id: 'ok' }, // duplicate of the first valid one
      { ...good, id: 'k1', kind: 'quiz' },
      { ...good, id: 't1', text: { en: 'only english' } },
      { ...good, id: 'o1', options: [t('a')], correct: 0 },
      { ...good, id: 'o2', options: [t('a'), { en: 'b' }] },
      { ...good, id: 'bg', kind: 'bride-or-groom', options: [t('a'), t('b'), t('c')], correct: 0 },
      { ...good, id: 'c1', correct: 'groom' },
      { ...good, id: 'c2', correct: 4 },
      { ...good, id: 'p1', kind: 'photo' },
      { ...good, id: 'p2', kind: 'photo', photo: '../../.env' },
      { ...good, id: 'p3', kind: 'photo', photo: 'baby.exe' },
      { ...good, id: 'p4', photo: 'baby.webp' }, // photo on a non-photo question
      { ...good, id: 'e1', text: t('') }, // no language at all
      { ...good, id: 'l2', text: t('x'.repeat(251)) },
      { ...good, id: 'l3', options: [t('a'), t('b'.repeat(101)), t('c')] },
      { ...good, id: 'd1', options: [t('Same'), t('same '), t('c')] },
    ];
    const errors = validateQuestions([good, ...bad]);
    expect(errors).toHaveLength(bad.length);
    expect(validateQuestions('nope')).toEqual(['questions must be an array']);
  });

  it('accepts drafts with missing translations, and knows which languages are missing', () => {
    const draft = { ...q('d1'), text: { ...t('Hi'), de: '   ', ca: '' } };
    expect(validateQuestions([draft])).toEqual([]);
    expect(incomplete([draft, q('ok')]).map((x) => x.id)).toEqual(['d1']);
    expect(missingLangs(draft)).toEqual(['ca', 'de']);
    // a missing key in a hand-written file becomes a missing translation, not a broken file
    const handWritten = [{ ...q('h1'), text: { en: 'Only English' } }];
    expect(validateQuestions(handWritten)).not.toEqual([]);
    expect(validateQuestions(tidyQuestions(handWritten))).toEqual([]);
  });

  it('drops the per-question time of files from before the one timer', () => {
    const old = [{ ...q('h1'), timeLimitSec: 15 }];
    expect(tidyQuestions(old)).toEqual([q('h1')]);
    expect(old[0]).toHaveProperty('timeLimitSec', 15); // the input is not changed
  });

  it('refuses to build a quiz from invalid questions', () => {
    expect(() => new Quiz([q('a', { correct: 9 })])).toThrow(/Invalid questions/);
  });

  it('refuses a snapshot taken with a different questions file', () => {
    const quiz = setup([q('q1'), q('q2'), q('q3')]);
    quiz.start(0);
    for (let t = 1; t <= 6; t++) quiz.next(t); // reveal, Top 10, q2, reveal, Top 10, q3
    const saved = JSON.parse(JSON.stringify(quiz.state)) as QuizState;
    expect(() => new Quiz([q('q1'), q('q2')], saved)).toThrow(/questions.json has changed/);
    expect(() => new Quiz([q('q1'), q('q3'), q('q2')], saved)).toThrow(
      /questions.json has changed/,
    );
    expect(() => new Quiz([q('q1'), q('q2'), q('q3')], saved)).not.toThrow();
  });
});

describe('restoreQuizState', () => {
  function played() {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 1, 2_000);
    return quiz;
  }

  it('restores a saved state exactly', () => {
    const quiz = played();
    const restored = restoreQuizState(JSON.parse(JSON.stringify(quiz.state)));
    expect(restored).toEqual(quiz.state);
    expect(() => new Quiz(quiz.questions, restored)).not.toThrow();
  });

  it('rejects broken or incomplete snapshots', () => {
    const base = () => JSON.parse(JSON.stringify(played().state)) as Record<string, unknown>;
    const cases: [string, (s: Record<string, unknown>) => void][] = [
      ['phase', (s) => (s.phase = 'party')],
      ['index', (s) => (s.index = 1.5)],
      ['timer', (s) => delete s.startedAt],
      ['players', (s) => delete s.players],
      [
        'answers',
        (s) => ((s.answers as Record<string, Record<string, unknown>>).ann!.limitMs = undefined),
      ],
      [
        'players',
        (s) => ((s.players as Record<string, Record<string, unknown>>).bob!.score = 'lots'),
      ],
      ['players', (s) => ((s.players as Record<string, Record<string, unknown>>).bob!.id = 'ann')],
    ];
    for (const [what, breakIt] of cases) {
      const s = base();
      breakIt(s);
      expect(() => restoreQuizState(s), what).toThrow(new RegExp(`Invalid snapshot: ${what}`));
    }
    expect(() => restoreQuizState('nope')).toThrow(/Invalid snapshot/);
  });

  it('rejects a snapshot with a "__proto__" key', () => {
    const json = JSON.stringify(played().state).replace(
      '"answers":{',
      '"answers":{"__proto__":{"option":1,"elapsedMs":1,"limitMs":1},',
    );
    expect(() => restoreQuizState(JSON.parse(json))).toThrow(/answers/);
  });
});
