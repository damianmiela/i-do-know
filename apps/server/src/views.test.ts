import { PODIUM_STEPS, type Localized, type RoundResult } from '@idoknow/shared';
import { describe, expect, it } from 'vitest';
import { Quiz, type Question } from './game/quiz';
import { Collect } from './game/collect';
import { GuestBook } from './guests';
import { SessionStore } from './sessions';
import {
  guestView,
  hostGuestRows,
  hostView,
  nextPodiumStep,
  placesHidden,
  ranksOf,
  screenView,
  type ScreenExtras,
  overallRows,
  rankingRows,
} from './views';

const t = (en: string): Localized => ({ pl: en, es: en, ca: en, de: en, en });
const q = (id: string, extra: Partial<Question> = {}): Question => ({
  id,
  kind: 'choice',
  text: t(id),
  options: [t('a'), t('b'), t('c'), t('d')],
  correct: 2,
  ...extra,
});
const COUNTRIES: Record<string, string> = { ann: 'PL', bob: 'ES' };
const EVENT = {
  title: t('Who knows Zofia & Xavi best?'),
  sides: { bride: 'Zofia', groom: 'Xavi' },
};
const screenExtras = (podiumShown = 0): ScreenExtras => ({
  event: EVENT,
  lang: 'en',
  joiningOpen: true,
  podiumShown,
  countryOf: (id) => COUNTRIES[id],
});
const extras = {
  ...screenExtras(),
  connectedGuests: 1,
  warnings: [],
  notes: ['content/guests.json is missing: the EXAMPLE guests are in use'],
  timeLimitSec: 20,
  autoReveal: true,
  readingStep: false,
  coupleMarked: {},
  coupleRound: false,
  activeSet: 'questions',
  playedSets: [],
  roundsPlayed: 0,
  overallShown: false,
  warmupAvailable: false,
  joinedGuests: 2,
  guestCount: 3,
  lastSavedAt: null,
  saveFailing: false,
  round: 0,
};

function setup() {
  const quiz = new Quiz([q('q1'), q('q2')], undefined, false, 20);
  quiz.addPlayer('ann', 'Ann');
  quiz.addPlayer('bob', 'Bob');
  return quiz;
}

/** Plays through every phase, collecting all views as JSON. */
function allViews() {
  const quiz = setup();
  const out: { phase: string; guest: string; screen: string; host: string }[] = [];
  const snap = (now: number) =>
    out.push({
      phase: quiz.state.phase,
      guest: JSON.stringify(guestView(quiz, 'ann', ranksOf(quiz), now)),
      screen: JSON.stringify(screenView(quiz, now, screenExtras())),
      host: JSON.stringify(hostView(quiz, now, extras)),
    });
  snap(0); // lobby
  quiz.start(0);
  quiz.answer('bob', 2, 1_000); // bob's pick must never reach ann
  snap(2_000); // question, ann not answered
  quiz.answer('ann', 0, 3_000);
  snap(4_000); // question, ann answered
  quiz.next(5_000);
  snap(5_000); // reveal
  quiz.next(6_000);
  snap(6_000); // leaderboard
  quiz.next(7_000);
  snap(7_000); // question 2
  quiz.next(8_000);
  quiz.next(9_000);
  snap(9_000); // final
  // the warm-up round and a photo question go through the same views
  const warmup = new Quiz(
    [q('w1'), q('p1', { kind: 'photo', photo: 'baby-1.webp' })],
    undefined,
    true,
  );
  warmup.addPlayer('ann', 'Ann');
  warmup.addPlayer('bob', 'Bob');
  const snapWarmup = (now: number) =>
    out.push({
      phase: warmup.state.phase,
      guest: JSON.stringify(guestView(warmup, 'ann', ranksOf(warmup), now)),
      screen: JSON.stringify(screenView(warmup, now, screenExtras())),
      host: JSON.stringify(hostView(warmup, now, extras)),
    });
  warmup.start(10_000);
  warmup.answer('bob', 2, 10_500);
  snapWarmup(11_000); // question
  warmup.next(12_000);
  snapWarmup(12_000); // reveal
  warmup.next(12_500);
  snapWarmup(12_500); // Top 10
  warmup.next(13_000);
  warmup.answer('bob', 2, 13_500);
  snapWarmup(14_000); // photo question
  warmup.next(15_000);
  snapWarmup(15_000); // reveal
  warmup.next(16_000);
  snapWarmup(16_000); // final
  return out;
}

describe('views never leak secrets', () => {
  it('no view contains a raw question or the quiz state', () => {
    for (const v of allViews()) {
      for (const json of [v.guest, v.screen, v.host]) {
        expect(json).not.toMatch(/"correct"|"answers"|"players"|"lastPoints"|"elapsedMs"/);
      }
    }
  });

  it('guests and the screen learn the correct answer only at the reveal', () => {
    for (const v of allViews()) {
      const leaks = v.phase !== 'reveal';
      for (const json of [v.guest, v.screen]) {
        if (leaks) expect(json).not.toContain('correctOption');
        else expect(json).toContain('"correctOption":2');
      }
    }
  });

  it("a guest never sees another guest's pick or the host's notes", () => {
    for (const v of allViews()) {
      const guest = JSON.parse(v.guest) as Record<string, unknown>;
      expect(guest.myAnswer === undefined || guest.myAnswer === 0).toBe(true);
      expect(v.guest).not.toMatch(/"country"|"top"|"podiumShown"|"lang"|"notes"|"warnings"/);
      expect(v.screen).not.toMatch(/"notes"|"warnings"|EXAMPLE/);
    }
  });

  it('only the host gets the answer key during the question, and the setup notes', () => {
    const quiz = setup();
    quiz.start(0);
    expect(hostView(quiz, 0, extras).answerKey).toBe(2);
    expect(hostView(quiz, 0, extras)).toMatchObject({ notes: extras.notes, timeLimitSec: 20 });
  });

  it('phones and the screen know whether joining is open', () => {
    const quiz = setup();
    expect(guestView(quiz, null, ranksOf(quiz), 0).joiningOpen).toBe(false);
    expect(guestView(quiz, null, ranksOf(quiz), 0, { joiningOpen: true }).joiningOpen).toBe(true);
    const closed = { ...screenExtras(), joiningOpen: false };
    expect(screenView(quiz, 0, closed).joiningOpen).toBe(false);
  });
});

describe('guestView', () => {
  it('shows own answer, points and rank after the reveal', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 2, 0);
    quiz.answer('bob', 1, 0);
    quiz.next(1_000);
    const v = guestView(quiz, 'ann', ranksOf(quiz), 1_000);
    expect(v).toMatchObject({ joined: true, name: 'Ann', myAnswer: 2, myPoints: 1000, rank: 1 });
    // before the first question nobody had a place to move from: no ▲/▼ after it
    expect(v.prevRank).toBeUndefined();
  });

  it('a guest without a name or player sees the game but is not joined', () => {
    const quiz = setup();
    quiz.start(0);
    const v = guestView(quiz, null, ranksOf(quiz), 5_000);
    expect(v).toMatchObject({ joined: false, phase: 'question', timeLeftMs: 15_000 });
    expect(v.question?.id).toBe('q1');
    expect(guestView(quiz, 'nobody', ranksOf(quiz), 0).joined).toBe(false);
  });

  it('a guest who joined after the reveal has no points yet', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.next(1_000);
    quiz.addPlayer('cid', 'Cid');
    const v = guestView(quiz, 'cid', ranksOf(quiz), 1_000);
    expect(v.myPoints).toBeUndefined();
    expect(v.prevRank).toBeUndefined();
  });
});

describe('screenView', () => {
  it('counts answers, shows option counts at the reveal and the top list after', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 2, 0);
    quiz.answer('bob', 2, 100);
    expect(screenView(quiz, 0, screenExtras())).toMatchObject({ answeredCount: 2, playerCount: 2 });
    expect(screenView(quiz, 0, screenExtras()).optionCounts).toBeUndefined();
    quiz.next(1_000);
    expect(screenView(quiz, 1_000, screenExtras()).optionCounts).toEqual([0, 0, 2, 0]);
    quiz.next(2_000);
    expect(screenView(quiz, 2_000, screenExtras()).top).toEqual([
      { rank: 1, name: 'Ann', score: 1000, country: 'PL', gained: 1000 },
      { rank: 2, name: 'Bob', score: 998, country: 'ES', gained: 998 },
    ]);
  });

  it('reports pause and time left', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.pause(5_000);
    expect(screenView(quiz, 9_000, screenExtras())).toMatchObject({
      paused: true,
      timeLeftMs: 15_000,
    });
  });
});

describe('Phase 4 fields', () => {
  it('lists the quiz photos for preloading, only in the lobby, only to guests with a name', () => {
    const quiz = new Quiz([q('q1'), q('p1', { kind: 'photo', photo: 'baby-1.webp' })]);
    quiz.addPlayer('ann', 'Ann');
    expect(guestView(quiz, 'ann', ranksOf(quiz), 0).photos).toEqual(['baby-1.webp']);
    // anyone can open the join link: a device without a name learns nothing about the photos
    expect(guestView(quiz, null, ranksOf(quiz), 0).photos).toBeUndefined();
    quiz.start(0);
    expect(guestView(quiz, 'ann', ranksOf(quiz), 0).photos).toBeUndefined();
  });

  it('answer time as soon as you answered (Phase 6.7), and only your own', () => {
    const quiz = setup();
    quiz.start(0);
    quiz.answer('ann', 2, 5_100);
    quiz.answer('bob', 1, 3_000);
    const during = guestView(quiz, 'ann', ranksOf(quiz), 6_000);
    expect(during).toMatchObject({ answeredCount: 2, myAnswer: 2, correctCount: 0 });
    expect(during.myAnswerMs).toBe(5_100);
    expect(JSON.stringify(during)).not.toContain('3000'); // bob's time
    quiz.next(7_000);
    const after = guestView(quiz, 'ann', ranksOf(quiz), 7_000);
    expect(after).toMatchObject({ myAnswerMs: 5_100, correctCount: 1, answeredCount: 2 });
    expect(JSON.stringify(after)).not.toContain('3000'); // bob's time
    quiz.next(8_000); // leaderboard
    expect(guestView(quiz, 'ann', ranksOf(quiz), 8_000).answeredCount).toBeUndefined();
  });
});

describe('Phase 3 fields', () => {
  it("a guest's view holds only their own wristband and no guest list", () => {
    const quiz = setup();
    const v = guestView(quiz, 'ann', ranksOf(quiz), 0, { band: 'K7P2' });
    expect(v.band).toBe('K7P2');
    expect(guestView(quiz, 'bob', ranksOf(quiz), 0).band).toBeUndefined();
    expect(guestView(quiz, null, ranksOf(quiz), 0, { band: 'K7P2' }).band).toBeUndefined(); // not joined
    expect(JSON.stringify(v)).not.toMatch(/"side"|"claimed"|"online"|Bob/);
  });

  it('host rows show claim, online, band and added status', () => {
    const guests = new GuestBook(
      [
        { id: 'ann', name: 'Ann', country: 'PL', side: 'bride' },
        { id: 'bob', name: 'Bob', country: 'ES', side: 'groom' },
      ],
      { 'added-1': { id: 'added-1', name: 'Cid', country: 'DE', side: 'groom' } },
    );
    const sessions = new SessionStore();
    sessions.bind('s'.repeat(22), 'ann', 0);
    sessions.bind('t'.repeat(22), 'bob', 0);
    const collect = new Collect(guests.all);
    collect.claimBand('ann', 'K7P2');
    const rows = hostGuestRows(guests, sessions, collect, new Set(['s'.repeat(22)]));
    expect(rows).toEqual([
      {
        id: 'ann',
        name: 'Ann',
        country: 'PL',
        side: 'bride',
        claimed: true,
        online: true,
        band: 'K7P2',
        added: false,
      },
      {
        id: 'bob',
        name: 'Bob',
        country: 'ES',
        side: 'groom',
        claimed: true,
        online: false,
        added: false,
      },
      {
        id: 'added-1',
        name: 'Cid',
        country: 'DE',
        side: 'groom',
        claimed: false,
        online: false,
        added: true,
      },
    ]);
  });
});

describe('Phase 5: big screen and podium', () => {
  /** Ann, Bob and Cid answer q1 and q2 at different speeds; the quiz ends in the final. */
  function finished(players = ['ann', 'bob', 'cid']) {
    const quiz = new Quiz([q('q1'), q('q2')], undefined, false, 20);
    for (const id of players) quiz.addPlayer(id, id.toUpperCase());
    quiz.start(0);
    players.forEach((id, i) => quiz.answer(id, 2, i * 1_000));
    quiz.next(5_000); // reveal q1
    quiz.next(5_000); // Top 10
    quiz.next(5_000); // q2
    players.forEach((id, i) => quiz.answer(id, 2, 5_000 + i * 1_000));
    quiz.next(10_000); // reveal q2 (the last question)
    return quiz;
  }

  it('the screen gets its language and the joining switch', () => {
    const quiz = setup();
    expect(screenView(quiz, 0, { ...screenExtras(), lang: 'pl' })).toMatchObject({
      lang: 'pl',
      joiningOpen: true,
      podiumShown: 0,
    });
  });

  it('the event title goes to the screen in the lobby only, the sides to the host only', () => {
    const quiz = setup();
    expect(screenView(quiz, 0, screenExtras()).title).toEqual(EVENT.title);
    expect(screenView(quiz, 0, screenExtras())).not.toHaveProperty('sides');
    expect(hostView(quiz, 0, extras).sides).toEqual(EVENT.sides);
    for (const v of allViews()) {
      expect(v.guest).not.toMatch(/Zofia|Xavi/);
      if (v.phase !== 'lobby') expect(v.screen).not.toMatch(/Zofia|Xavi/);
    }
  });

  it("phones hide places from the last question's reveal until the podium is complete", () => {
    const quiz = finished();
    expect(placesHidden(quiz, 0)).toBe(true); // last reveal
    const atReveal = guestView(quiz, 'ann', ranksOf(quiz), 10_000);
    expect(atReveal).toMatchObject({ rankHidden: true, myPoints: 1000, correctCount: 2 });
    expect(atReveal.rank).toBeUndefined();
    expect(atReveal.score).toBeUndefined();
    expect(atReveal.prevRank).toBeUndefined();
    quiz.next(11_000); // final
    for (const shown of [0, 1, 2]) {
      const v = guestView(quiz, 'ann', ranksOf(quiz), 11_000, { podiumShown: shown });
      expect(v.rank).toBeUndefined();
    }
    const done = guestView(quiz, 'ann', ranksOf(quiz), 11_000, { podiumShown: PODIUM_STEPS });
    expect(done).toMatchObject({ rank: 1, score: 2000 });
    expect(done.rankHidden).toBeUndefined();
  });

  it('earlier reveals show places; the warm-up plays the podium like the real quiz', () => {
    const quiz = new Quiz([q('q1'), q('q2')], undefined, false, 20);
    quiz.addPlayer('ann', 'Ann');
    quiz.start(0);
    quiz.next(1_000); // reveal of q1: not the last one
    expect(guestView(quiz, 'ann', ranksOf(quiz), 1_000).rank).toBe(1);
    const warmup = new Quiz([q('w1')], undefined, true);
    warmup.addPlayer('ann', 'Ann');
    warmup.start(0);
    warmup.answer('ann', 2, 500);
    warmup.next(1_000);
    // Phase 6.10 (Damian: "display podium after warm-up so people know what's up")
    expect(guestView(warmup, 'ann', ranksOf(warmup), 1_000).rankHidden).toBe(true);
    warmup.next(2_000);
    expect(warmup.state.phase).toBe('final');
    expect(screenView(warmup, 2_000, screenExtras()).top).toEqual([]);
    const shown = { podiumShown: PODIUM_STEPS };
    expect(guestView(warmup, 'ann', ranksOf(warmup), 2_000, shown).rank).toBe(1);
    expect(screenView(warmup, 2_000, screenExtras(PODIUM_STEPS)).top).toHaveLength(1);
  });

  it('the screen gets the podium place by place, the host sees it all', () => {
    const quiz = finished();
    quiz.next(11_000); // final
    const names = (shown: number) =>
      screenView(quiz, 11_000, screenExtras(shown)).top?.map((r) => r.name);
    expect(names(0)).toEqual([]);
    expect(names(1)).toEqual(['CID']);
    expect(names(2)).toEqual(['BOB', 'CID']);
    expect(names(3)).toEqual(['ANN', 'BOB', 'CID']);
    expect(hostView(quiz, 11_000, extras).top?.map((r) => r.name)).toEqual(['ANN', 'BOB', 'CID']);
    expect(hostView(quiz, 11_000, extras).podiumShown).toBe(0);
  });

  it('the podium skips places nobody holds', () => {
    const two = finished(['ann', 'bob']);
    two.next(11_000);
    expect(nextPodiumStep(two, 0)).toBe(2); // no 3rd place: straight to 2nd
    expect(nextPodiumStep(two, 2)).toBe(3);
    const none = new Quiz([q('q1')]);
    none.start(0);
    none.next(1_000);
    none.next(2_000);
    expect(nextPodiumStep(none, 0)).toBe(PODIUM_STEPS);
    const three = finished();
    three.next(11_000);
    expect([1, 2, 3].map((s) => nextPodiumStep(three, s - 1))).toEqual([1, 2, 3]);
  });

  it('podiumShown counts only in a final (the warm-up has one too)', () => {
    const quiz = setup();
    expect(screenView(quiz, 0, screenExtras(2)).podiumShown).toBe(0); // lobby
    const warmup = new Quiz([q('w1')], undefined, true);
    warmup.addPlayer('ann', 'Ann');
    warmup.start(0);
    warmup.next(1_000);
    warmup.next(2_000); // the warm-up's final
    expect(screenView(warmup, 2_000, screenExtras(2)).podiumShown).toBe(2);
  });

  it('the podium holds places 1 to 3 only, never players with 0 points', () => {
    // ann, bob, cid, dan, eve answer at different speeds; dan and eve tie for 4th; fay never answers
    const quiz = new Quiz([q('q1')]);
    for (const id of ['ann', 'bob', 'cid', 'dan', 'eve', 'fay']) quiz.addPlayer(id, id);
    quiz.start(0);
    quiz.answer('ann', 2, 0);
    quiz.answer('bob', 2, 1_000);
    quiz.answer('cid', 2, 2_000);
    quiz.answer('dan', 2, 3_000);
    quiz.answer('eve', 2, 3_000);
    quiz.next(5_000);
    quiz.next(6_000); // final
    const podium = screenView(quiz, 6_000, screenExtras(PODIUM_STEPS)).top ?? [];
    expect(podium.map((r) => [r.rank, r.name])).toEqual([
      [1, 'ann'],
      [2, 'bob'],
      [3, 'cid'],
    ]);
  });

  it('a tie for 3rd shows both; a place held only by 0-point players is skipped', () => {
    const quiz = new Quiz([q('q1')]);
    for (const id of ['ann', 'bob', 'cid', 'dan']) quiz.addPlayer(id, id);
    quiz.start(0);
    quiz.answer('ann', 2, 0);
    quiz.answer('bob', 2, 1_000);
    quiz.answer('cid', 2, 2_000);
    quiz.answer('dan', 2, 2_000);
    quiz.next(5_000);
    quiz.next(6_000);
    expect(screenView(quiz, 6_000, screenExtras(1)).top?.map((r) => r.name)).toEqual([
      'cid',
      'dan',
    ]);
    // only 0-point players share 2nd and 3rd place: one tap reveals the winner
    const small = new Quiz([q('q1')]);
    for (const id of ['ann', 'bob', 'cid']) small.addPlayer(id, id);
    small.start(0);
    small.answer('ann', 2, 0);
    small.next(1_000);
    small.next(2_000);
    expect(nextPodiumStep(small, 0)).toBe(PODIUM_STEPS);
    expect(screenView(small, 2_000, screenExtras(PODIUM_STEPS)).top?.map((r) => r.name)).toEqual([
      'ann',
    ]);
  });
});

describe('full ranking (Phase 6.9)', () => {
  it('phones get everyone with their own row marked, and never guest ids', () => {
    const quiz = new Quiz([q('q1')], undefined, false, 20);
    quiz.addPlayer('ann', 'Ann');
    quiz.addPlayer('bob', 'Bob');
    quiz.start(0);
    quiz.answer('bob', 2, 1_000);
    quiz.next(2_000);
    quiz.next(2_000); // final
    const rows = rankingRows(quiz, (id) => COUNTRIES[id]);
    const mine = guestView(quiz, 'ann', ranksOf(quiz), 0, {
      podiumShown: PODIUM_STEPS,
      ranking: rows,
    });
    expect(mine.ranking).toEqual([
      { rank: 1, name: 'Bob', score: 975 },
      { rank: 2, name: 'Ann', score: 0, me: true },
    ]);
    expect(JSON.stringify(mine)).not.toMatch(/"id":"(ann|bob)"/);
    const screen = screenView(quiz, 0, { ...screenExtras(PODIUM_STEPS), ranking: rows });
    expect(screen.ranking?.map((r) => r.name)).toEqual(['Bob', 'Ann']);
    expect(JSON.stringify(screen.ranking)).not.toContain('"id"');
    // the ranking is one more step after the podium
    const without = hostView(quiz, 0, { ...extras, podiumShown: PODIUM_STEPS });
    const withIt = hostView(quiz, 0, { ...extras, podiumShown: PODIUM_STEPS, ranking: rows });
    expect(withIt.step).not.toBe(without.step);
  });
});

describe('phones between questions (Phase 6.10)', () => {
  it('get themselves with up to 3 places above and below, with last points and old places', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
    const quiz = new Quiz([q('q1'), q('q2')], undefined, false, 20);
    for (const id of ids) quiz.addPlayer(id, id.toUpperCase());
    quiz.start(0);
    ids.forEach((id, i) => quiz.answer(id, 2, 1_000 + i * 1_000)); // p1 fastest
    quiz.next(15_000);
    quiz.next(15_000); // Top 10
    const rows = guestView(quiz, 'p5', ranksOf(quiz), 15_000).around;
    expect(rows?.map((r) => r.name)).toEqual(['P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    expect(rows?.[3]).toMatchObject({ rank: 5, me: true, gained: 875 });
    expect(rows?.some((r) => 'country' in r)).toBe(false); // not shown on phones: not sent
    // "the next round starts soon" only in the waiting room
    expect(guestView(quiz, 'p5', ranksOf(quiz), 15_000, { roundsPlayed: 1 })).not.toHaveProperty(
      'roundsPlayed',
    );
    expect(rows?.filter((r) => r.me)).toHaveLength(1);
    // at the top: nobody above
    const first = guestView(quiz, 'p1', ranksOf(quiz), 15_000).around;
    expect(first?.map((r) => r.name)).toEqual(['P1', 'P2', 'P3', 'P4']);
    // only in the Top 10 phase
    quiz.next(16_000);
    expect(guestView(quiz, 'p5', ranksOf(quiz), 16_000).around).toBeUndefined();
  });
});

describe('between rounds (audit 9)', () => {
  it('the waiting room knows a round was played ("the next round starts soon")', () => {
    const quiz = setup();
    expect(guestView(quiz, 'ann', ranksOf(quiz), 0, { roundsPlayed: 2 }).roundsPlayed).toBe(2);
    expect(guestView(quiz, 'ann', ranksOf(quiz), 0, { roundsPlayed: 0 })).not.toHaveProperty(
      'roundsPlayed',
    );
  });
});

describe('overall ranking (Phase 6.10)', () => {
  it('adds up every round; equal totals and correct answers share a place', () => {
    const rounds: RoundResult[] = [
      {
        setId: 'questions',
        setName: 'Main quiz',
        finishedAt: 1,
        players: {
          ann: { name: 'Ann', score: 900, correctCount: 2 }, // more right answers: ahead on a tie
          bob: { name: 'Bob', score: 1_800, correctCount: 2 },
        },
      },
      {
        setId: 'set-ab12',
        setName: 'Poland vs Spain',
        finishedAt: 2,
        players: {
          ann: { name: 'Ann', score: 900, correctCount: 1 },
          cid: { name: 'Cid', score: 1_800, correctCount: 2 },
        },
      },
    ];
    expect(overallRows(rounds, (id) => COUNTRIES[id])).toEqual([
      { id: 'ann', rank: 1, name: 'Ann', score: 1_800, country: 'PL' },
      { id: 'bob', rank: 2, name: 'Bob', score: 1_800, country: 'ES' },
      { id: 'cid', rank: 2, name: 'Cid', score: 1_800 },
    ]);
  });
});
