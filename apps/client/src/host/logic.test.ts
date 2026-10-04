import { describe, expect, it } from 'vitest';
import type { HostView, RankRow } from '@idoknow/shared';
import type { ArchivedQuestion, HostQuestion } from '@idoknow/shared';
import {
  allLists,
  canShowPast,
  gameWhen,
  matches,
  nextAction,
  nextPodiumPlace,
  notConnected,
  parseTimer,
  questionsOf,
  roundLists,
  phaseLine,
  savedLine,
  timerLabel,
  voteCounts,
} from './logic';

const row = (rank: number, score: number): RankRow => ({ rank, name: `P${rank}`, score });

const view = (over: Partial<HostView> = {}): HostView => ({
  phase: 'lobby',
  questionNumber: 0,
  questionCount: 3,
  timeLeftMs: 0,
  paused: false,
  playerCount: 5,
  answeredCount: 0,
  lang: 'en',
  joiningOpen: true,
  podiumShown: 0,
  connectedGuests: 4,
  sides: { bride: 'Anna', groom: 'Ben' },
  warnings: [],
  notes: [],
  timeLimitSec: 60,
  autoReveal: false,
  readingStep: false,
  coupleMarked: {},
  coupleRound: false,
  activeSet: 'questions',
  playedSets: [],
  roundsPlayed: 0,
  overallShown: false,
  warmupAvailable: true,
  joinedGuests: 5,
  guestCount: 8,
  saveFailing: false,
  step: '0.q.lobby.-1.0',
  pauseStep: '0.q.lobby.-1.0.r',
  ...over,
});

describe('nextAction', () => {
  it('walks through the whole quiz, one step at a time', () => {
    const lobby = nextAction(view());
    expect(lobby).toMatchObject({ event: 'host:start', label: 'Start the quiz' });
    expect(lobby.confirm?.body).toMatch(/5 guests have joined/);
    expect(lobby.confirm?.body).not.toMatch(/closed/);
    expect(nextAction(view({ joiningOpen: false })).confirm?.body).toMatch(/Joining is closed/);
    expect(nextAction(view({ phase: 'question', questionNumber: 1 }))).toMatchObject({
      event: 'host:next',
      label: 'Reveal the answer',
      then: 'then: Top 10',
    });
    expect(nextAction(view({ phase: 'reveal', questionNumber: 1 })).label).toBe('Show the Top 10');
    expect(
      nextAction(view({ phase: 'question', questionNumber: 1, autoReveal: true })).then,
    ).toMatch(/^or by itself when time is up/);
    expect(nextAction(view({ phase: 'leaderboard', questionNumber: 1 }))).toMatchObject({
      label: 'Next question',
      then: 'Question 2 of 3',
    });
    expect(nextAction(view({ phase: 'question', questionNumber: 3 })).then).toBe(
      'then: the podium',
    );
    expect(nextAction(view({ phase: 'reveal', questionNumber: 3 })).label).toBe('Go to the podium');
  });

  it("the couple's review after the full ranking (Phase 9.5)", () => {
    const done = { phase: 'final' as const, podiumShown: 3, ranking: [], coupleRound: true };
    expect(nextAction(view(done))).toMatchObject({
      event: 'host:coupleNext',
      label: "The couple's answers",
    });
    expect(nextAction(view({ ...done, couple: { total: 2, n: 1 } })).label).toBe(
      'Couple: question 2 of 2',
    );
    expect(nextAction(view({ ...done, couple: { total: 2, n: 2 } })).label).toBe(
      'Show how well they know each other',
    );
    expect(
      nextAction(view({ ...done, couple: { total: 2, summary: { bothAnswered: 2, agreed: 1 } } })),
    ).toMatchObject({ event: null });
    // no couple round: the full ranking is the end, as before
    expect(nextAction(view({ ...done, coupleRound: false })).event).toBeNull();
  });

  it('reading time: "Show the answers" first, then the reveal (Phase 9.5)', () => {
    expect(nextAction(view({ phase: 'question', questionNumber: 1, reading: true }))).toMatchObject(
      {
        event: 'host:showAnswers',
        label: 'Show the answers',
      },
    );
    expect(phaseLine(view({ phase: 'question', questionNumber: 1, reading: true }), 20)).toBe(
      'Question 1 of 3 · reading time',
    );
  });

  it('reveals the podium place by place, then stops', () => {
    const top = [row(1, 3000), row(2, 2000), row(3, 1000)];
    const labels = [0, 1, 2].map(
      (shown) => nextAction(view({ phase: 'final', podiumShown: shown, top })).label,
    );
    expect(labels).toEqual(['Reveal 3rd place', 'Reveal 2nd place', 'Reveal the winner']);
    // then everyone's place (Phase 6.9), then the end
    expect(nextAction(view({ phase: 'final', podiumShown: 3 }))).toMatchObject({
      event: 'host:showRanking',
      label: 'Show the full ranking',
    });
    expect(nextAction(view({ phase: 'final', podiumShown: 3, ranking: [] }))).toMatchObject({
      event: null,
    });
    // the overall ranking on the screen (Phase 6.10): no step, say what is shown
    expect(
      nextAction(view({ phase: 'final', podiumShown: 3, ranking: [], overallRounds: 2 })),
    ).toMatchObject({ event: null, then: 'the overall ranking is shown' });
  });

  it('the warm-up ends with "End the warm-up", never with the podium', () => {
    expect(nextAction(view({ phase: 'leaderboard', questionNumber: 1, warmup: true })).label).toBe(
      'Next practice question',
    );
    expect(nextAction(view({ phase: 'reveal', questionNumber: 3, warmup: true })).label).toBe(
      'Show the practice results',
    );
    // its podium first (Phase 6.10), then the end
    const top = [row(1, 900)];
    expect(nextAction(view({ phase: 'final', warmup: true, top }))).toMatchObject({
      event: 'host:podiumNext',
      label: 'Reveal the winner',
    });
    expect(nextAction(view({ phase: 'final', warmup: true, podiumShown: 3 }))).toMatchObject({
      event: 'host:endWarmup',
    });
  });
});

describe('the start waits for the translations', () => {
  it('shows what is missing instead of starting', () => {
    expect(nextAction(view(), 2)).toMatchObject({
      event: null,
      label: 'Complete the translations first',
      then: '2 questions miss languages (Questions)',
    });
    expect(nextAction(view(), 0).event).toBe('host:start');
  });
});

describe('podium labels name the place the tap really shows', () => {
  const final = (top: RankRow[], podiumShown = 0) => view({ phase: 'final', top, podiumShown });

  it('one scorer: straight to the winner', () => {
    const top = [row(1, 900), row(2, 0), row(2, 0)];
    expect(nextPodiumPlace(final(top))).toBe(1);
    expect(nextAction(final(top))).toMatchObject({
      label: 'Reveal the winner',
      then: 'nobody is 2nd or 3rd',
    });
  });

  it('two scorers: 2nd first, saying nobody is 3rd', () => {
    const top = [row(1, 900), row(2, 800), row(3, 0)];
    expect(nextAction(final(top))).toMatchObject({
      label: 'Reveal 2nd place',
      then: 'nobody is 3rd',
    });
    expect(nextAction(final(top, 2)).label).toBe('Reveal the winner');
  });

  it('a tie for 1st: nobody is 2nd', () => {
    const top = [row(1, 900), row(1, 900), row(3, 500)];
    expect(nextAction(final(top)).label).toBe('Reveal 3rd place');
    expect(nextAction(final(top, 1))).toMatchObject({
      label: 'Reveal the winner',
      then: 'nobody is 2nd',
    });
  });

  it('nobody scored: one tap closes the podium', () => {
    expect(nextAction(final([row(1, 0)]))).toMatchObject({
      event: 'host:podiumNext',
      label: 'Close the podium',
    });
  });
});

describe('status lines', () => {
  it('says where the game is', () => {
    expect(phaseLine(view(), 0)).toBe('Waiting room');
    expect(phaseLine(view({ phase: 'question', questionNumber: 2 }), 9)).toBe(
      'Question 2 of 3 · 9 s left',
    );
    expect(phaseLine(view({ phase: 'question', questionNumber: 2, paused: true }), 9)).toMatch(
      /paused/,
    );
    expect(phaseLine(view({ phase: 'final', podiumShown: 1 }), 0)).toBe(
      'Podium · 1 of 3 places revealed',
    );
    expect(phaseLine(view({ phase: 'question', questionNumber: 1, warmup: true }), 5)).toMatch(
      /^Practice Question 1/,
    );
    expect(phaseLine(view({ phase: 'final', podiumShown: 2, warmup: true }), 0)).toBe(
      'Practice Podium · 2 of 3 places revealed',
    );
  });

  it('counts the time since the last save', () => {
    expect(savedLine(undefined, 0)).toBeNull();
    expect(savedLine(2_000, 1_500)).toBe('saved 3 s ago');
    expect(savedLine(119_000, 2_000)).toBe('saved 2 min ago');
  });

  it('counts joined guests without a connection', () => {
    expect(notConnected(view({ joinedGuests: 5, connectedGuests: 4 }))).toBe(1);
    expect(notConnected(view({ joinedGuests: 2, connectedGuests: 4 }))).toBe(0); // copied cookies
  });

  it('finds guests ignoring accents', () => {
    const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    expect(matches('Núria Puigdomènech', 'nuria', fold)).toBe(true);
    expect(matches('Núria', '', fold)).toBe(true);
    expect(matches('Jordi', 'nu', fold)).toBe(false);
  });
});

describe('the timer field', () => {
  it('takes seconds or minutes:seconds, within the limits', () => {
    expect(parseTimer('60')).toBe(60);
    expect(parseTimer(' 90 s ')).toBe(90);
    expect(parseTimer('45 sec')).toBe(45);
    expect(parseTimer('1:30')).toBe(90);
    expect(parseTimer('5:00')).toBe(300);
    for (const bad of ['', '9', '301', '5:01', '1.5', 'abc', '-20', '1:3']) {
      expect(parseTimer(bad)).toBeNull();
    }
  });

  it('reads nicely', () => {
    expect(timerLabel(45)).toBe('45 s');
    expect(timerLabel(60)).toBe('1 min');
    expect(timerLabel(90)).toBe('1 min 30 s');
  });
});

describe('past games', () => {
  it('go on the big screen only in the waiting room or after the quiz', () => {
    expect(canShowPast(view())).toBe(true);
    expect(canShowPast(view({ phase: 'final', podiumShown: 3 }))).toBe(true);
    expect(canShowPast(view({ phase: 'final', podiumShown: 1 }))).toBe(false); // mid-podium
    expect(canShowPast(view({ phase: 'question' }))).toBe(false);
    expect(canShowPast(view({ phase: 'final', warmup: true }))).toBe(false);
  });

  it('counts the votes per option and dates the game', () => {
    const q = {
      options: [{}, {}, {}],
      answers: [{ option: 1 }, { option: 1 }, { option: 2 }],
    } as unknown as ArchivedQuestion;
    expect(voteCounts(q)).toEqual([0, 2, 1]);
    expect(gameWhen(Date.UTC(2026, 8, 12, 12, 0))).toMatch(/12 Sept? 2026/);
  });
});

describe('question lists (Phase 6.10)', () => {
  const q = (id: string) => ({ id }) as unknown as HostQuestion;
  const lists = {
    questions: [q('q1')],
    warmup: [q('w1')],
    sets: [{ id: 'set-ab12', name: 'Songs', questions: [q('s1'), q('s2')] }],
  };
  it('lists the main quiz, the warm-up and the sets; rounds never play the warm-up', () => {
    expect(allLists(lists).map((l) => l.name)).toEqual(['Main quiz', 'Warm-up', 'Songs']);
    expect(roundLists(lists).map((l) => l.id)).toEqual(['questions', 'set-ab12']);
    expect(questionsOf(lists, 'set-ab12')).toHaveLength(2);
    expect(questionsOf(lists, 'set-gone')).toEqual([]);
  });
});
