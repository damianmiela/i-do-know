// Shared types and Socket.IO event definitions, used by both client and server.

export const LANGS = ['pl', 'es', 'ca', 'de', 'en'] as const;
export type Lang = (typeof LANGS)[number];
/** A text in all five languages. */
export type Localized = Record<Lang, string>;

export type QuizPhase = 'lobby' | 'question' | 'reveal' | 'leaderboard' | 'final';
export type QuestionKind = 'choice' | 'bride-or-groom' | 'photo';

/** What clients may see of a question: never includes the correct answer. */
export interface PublicQuestion {
  id: string;
  kind: QuestionKind;
  text: Localized;
  options: Localized[];
  /** The countdown (one for all questions, set by the host). */
  timeLimitSec: number;
  photo?: string;
}

/** One of the couple's answers on a review slide (Phase 9.5). No option = no answer. */
export interface CouplePick {
  name: string;
  option?: number;
}

/** How one of the couple did over the round (the review's summary slide). */
export interface CoupleScore {
  name: string;
  /** Right answers, of `CoupleSlide.total`. */
  correct: number;
  /** Where they would have stood in the ranking (for fun; missing if they didn't play). */
  wouldRank?: number;
}

/**
 * After the podium, when the couple played along (Phase 9.5): the big screen (and the phones,
 * smaller) go through the questions with the bride's and the groom's answers, then a summary.
 */
export interface CoupleSlide {
  /** Questions in the review (the ones played, not skipped). */
  total: number;
  /** 1-based; missing on the summary slide. */
  n?: number;
  /** The question with its right answer (the round is over: nothing is secret any more). */
  question?: PublicQuestion & { correct: number };
  bride?: CouplePick;
  groom?: CouplePick;
  summary?: {
    bride?: CoupleScore;
    groom?: CoupleScore;
    /** Questions both answered, and those with the same answer. */
    bothAnswered: number;
    agreed: number;
  };
}

/** A plain image file name in content/photos: no folders, no "..". */
export const PHOTO_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(webp|jpg|jpeg|png)$/i;
export const QUESTION_KINDS: readonly QuestionKind[] = ['choice', 'bride-or-groom', 'photo'];
/** Longest question text / answer per language (the big screen shrinks long texts, up to here). */
export const QUESTION_TEXT_MAX = 250;
export const ANSWER_TEXT_MAX = 100;
/** One countdown for every question (the host sets it in the waiting room), in seconds. */
export const TIMER_MIN_SEC = 10;
export const TIMER_MAX_SEC = 300;
export const TIMER_DEFAULT_SEC = 60;
export const isTimerSec = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= TIMER_MIN_SEC && (v as number) <= TIMER_MAX_SEC;

/**
 * The join link, the same for everyone and all evening (QR code, stickers, typed): the domain
 * plus this path. Whether it lets new guests in is the host's switch (`joiningOpen`).
 */
export const JOIN_PATH = '/join';

/** A text object with every language key a string ('' = translation still missing). */
const isTexts = (v: unknown): v is Localized =>
  typeof v === 'object' &&
  v !== null &&
  LANGS.every((l) => typeof (v as Record<string, unknown>)[l] === 'string');
const filled = (t: Localized) => LANGS.some((l) => t[l].trim() !== '');

/**
 * The languages still missing anywhere in a question (its text or any answer). A question may be
 * saved like that (a draft), but the quiz can't start until nothing is missing.
 */
export function missingLangs(q: { text: Localized; options: readonly Localized[] }): Lang[] {
  return LANGS.filter((l) => [q.text, ...q.options].some((t) => !t[l]?.trim()));
}

/**
 * What's wrong with one question's content (everything but its id). Empty = it can be saved.
 * The server (questions.json, the editor's saves) and the editor use the same rules.
 */
export function questionProblems(raw: unknown): string[] {
  const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const kind = q.kind as QuestionKind;
  if (!QUESTION_KINDS.includes(kind)) errors.push('unknown kind');
  if (!isTexts(q.text)) errors.push('text needs a string for every language');
  else if (!filled(q.text)) errors.push('text is empty');
  else if (LANGS.some((l) => (q.text as Localized)[l].length > QUESTION_TEXT_MAX)) {
    errors.push(`text longer than ${QUESTION_TEXT_MAX} characters`);
  }
  const options = Array.isArray(q.options) ? (q.options as unknown[]) : [];
  const n = options.length;
  if (n < 2 || n > 4) errors.push('needs 2 to 4 options');
  else if (!options.every(isTexts)) errors.push('every option needs a string for every language');
  else if (!options.every(filled)) errors.push('an option is empty');
  else if (options.some((o) => LANGS.some((l) => o[l].length > ANSWER_TEXT_MAX))) {
    errors.push(`an option is longer than ${ANSWER_TEXT_MAX} characters`);
  } else {
    for (const l of LANGS) {
      const texts = options.map((o) => o[l].trim().toLowerCase()).filter((t) => t !== '');
      if (new Set(texts).size !== texts.length) {
        errors.push(`two options have the same text (${l})`);
        break;
      }
    }
  }
  if (kind === 'bride-or-groom' && n !== 2) errors.push('bride-or-groom needs exactly 2 options');
  const correct = q.correct;
  if (!Number.isInteger(correct) || (correct as number) < 0 || (correct as number) >= n) {
    errors.push('correct must be an option index');
  }
  if (kind === 'photo' && typeof q.photo !== 'string') errors.push('photo file missing');
  if (kind !== 'photo' && q.photo !== undefined)
    errors.push('photo only belongs on photo questions');
  if (
    q.photo !== undefined &&
    (typeof q.photo !== 'string' || !PHOTO_NAME.test(q.photo) || q.photo.includes('..'))
  ) {
    errors.push('photo must be a plain image file name like baby-1.webp');
  }
  return errors;
}

/**
 * Answers that arrive up to this long after the countdown ended still count, at the minimum
 * points: on weak roaming data a tap can take a while to reach the server. The phone shows
 * "time's up" only after this too.
 */
export const ANSWER_GRACE_MS = 2_000;

/** Why the quiz refused an action. */
export type QuizError =
  | 'wrong-phase'
  | 'unknown-player'
  | 'invalid-player'
  | 'invalid-option'
  | 'invalid-time'
  | 'already-answered'
  | 'time-up'
  | 'paused'
  | 'no-questions';

/** Why collect mode refused a wristband action. */
export type CollectError =
  | 'unknown-guest'
  | 'unknown-band'
  | 'invalid-code'
  | 'band-taken'
  | 'already-has-band'
  | 'self'
  | 'already-collected'
  | 'rate-limited';

/** Why the server refused a socket action: a game rule, or a problem with the request itself. */
export type ActionError =
  | QuizError
  | CollectError
  | 'not-joined' // the device hasn't picked its name yet
  | 'collect-off' // collect mode (wristbands) is not in use
  | 'already-joined' // the device already has a name (the host can release it)
  | 'name-taken' // another device picked this name (the host can release it)
  | 'joining-closed' // the host hasn't opened joining (yet): no new names now
  | 'wrong-question' // an answer meant for an earlier question arrived late: ignored
  | 'no-warmup' // no warm-up questions in questions.json
  | 'stale' // a host tapped a step that was already taken (double tap, a second host)
  | 'translations-missing' // the quiz can't start: a question still misses a language
  | 'editing-locked' // questions can only be edited in the waiting room (not during the warm-up)
  | 'invalid-question' // the edited question breaks a rule (questionProblems)
  | 'unknown-question'
  | 'unknown-photo' // the photo file isn't in content/photos
  | 'unknown-game' // no saved game with this id
  | 'not-added' // only guests the host added can be removed (guests.json is edited in the file)
  | 'unknown-set' // no question set with this id
  | 'duplicate-name' // host: a guest (or a question set) with this name already exists
  | 'query-too-short'
  | 'forbidden'
  | 'invalid-input'
  | 'server-error';

/** Reply to every client action; some carry data (e.g. search results). */
export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: ActionError };

export type Side = 'bride' | 'groom';

/**
 * content/event.json: who the quiz is about. Private like the guest list (only the example file
 * with a made-up couple is in git), so the app works for any couple.
 */
export interface EventInfo {
  /** The big screen's lobby title, per language (names change form, e.g. Polish cases). */
  title: Localized;
  /** How the host panel names the two sides of the guest list, e.g. "Anna" and "Ben". */
  sides: Record<Side, string>;
}

/**
 * Text folded for search: lower case, no accents, special letters mapped to plain ones
 * ("Łukasz" → "lukasz", "Núria" → "nuria", "Jürgen Weiß" → "jurgen weiss", "Col·lell" →
 * "collell", "O'Brien" → "obrien"). Letters of other scripts stay (Cyrillic finds Cyrillic).
 * With `umlautsAsE`, ä/ö/ü become ae/oe/ue, the German way of typing them ("Juergen").
 */
export function foldText(text: string, umlautsAsE = false): string {
  const t = umlautsAsE
    ? // NFC first: a file saved on a Mac may hold "ü" as "u" + a separate dot mark
      text.normalize('NFC').replace(/[äöüÄÖÜ]/g, (c) => `${c.normalize('NFD')[0]!.toLowerCase()}e`)
    : text;
  return t
    .normalize('NFKD') // also splits ligatures and full-width letters (ﬁ → fi, Ｊ → J)
    .replace(/\p{M}/gu, '') // accents (ó, ñ, ü, ç, ż, ě …)
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ı/g, 'i')
    .replace(/ß/g, 'ss')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/þ/g, 'th')
    .replace(/[đð]/g, 'd')
    .replace(/['’ʼ`·]/g, '') // inside words: O'Brien, Col·lell
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // hyphens, dots, emoji … → spaces
    .trim();
}

/** One result of the phone's name search. */
export interface NameMatch {
  id: string;
  name: string;
  /** e.g. "PL", "ES", "DE": shown as a flag. */
  country: string;
  /** Another device already picked this name: shown, but can't be tapped. */
  taken: boolean;
}

/** One guest in the host panel's list. */
export interface HostGuestRow {
  id: string;
  name: string;
  country: string;
  side: Side;
  /** A device picked this name. */
  claimed: boolean;
  /** That device is connected right now. */
  online: boolean;
  /** Linked wristband code. */
  band?: string;
  /** Added from the host panel (not in guests.json). */
  added: boolean;
  /** Marked in guests.json as the bride or the groom (Phase 9.5). */
  role?: Side;
}

/** Which page a socket belongs to. Sent in the Socket.IO handshake (`auth.view`). */
export type View = 'play' | 'screen' | 'host';

export interface RankRow {
  rank: number;
  name: string;
  score: number;
  /** The guest's country from the guest list (e.g. "PL"), for the flag. */
  country?: string;
  /** Rank just before the last reveal, for "▲ 3". */
  prevRank?: number;
  /** Points from the last reveal (the big screen counts the score up from score − gained). */
  gained?: number;
  /** A phone's own row in the full ranking (Phase 6.9). */
  me?: true;
}

/** How many players the big screen's Top 10 shows. */
export const TOP_COUNT = 10;

/** How many podium places the host has revealed on the big screen (3rd, then 2nd, then 1st). */
export const PODIUM_STEPS = 3;

/** Shared by all views. `timeLeftMs` is measured when the view is sent: count down locally from there. */
export interface QuizViewBase {
  phase: QuizPhase;
  /** 1-based; 0 in the lobby. */
  questionNumber: number;
  questionCount: number;
  /** Only in the question and reveal phases. */
  question?: PublicQuestion;
  timeLeftMs: number;
  paused: boolean;
  playerCount: number;
  /** Only in the reveal phase. */
  correctOption?: number;
  /** A warm-up round is being played: its points don't count for the real quiz. */
  warmup?: boolean;
  /**
   * Reading time (Phase 9.5): the question is shown without its answers (`question.options` is
   * empty) and the countdown stands still until the host shows the answers.
   */
  reading?: true;
}

/** One guest's phone. Holds only that guest's own data. */
export interface GuestView extends QuizViewBase {
  /** False until the device is linked to a name on the guest list (Phase 3). */
  joined: boolean;
  /** The host lets new guests pick a name. Closed: a device without a name sees "too early". */
  joiningOpen: boolean;
  /** Photo file names of the quiz (lobby only), to preload from /photos/<name>. */
  photos?: string[];
  name?: string;
  /** The wristband this guest linked ("this is me"). */
  band?: string;
  /** How many players answered (question and reveal phases). */
  answeredCount?: number;
  /** The option this guest picked (question and reveal phases). */
  myAnswer?: number;
  /** How long this guest took to answer, by the server's clock (once answered). */
  myAnswerMs?: number;
  /** Correct answers so far. */
  correctCount?: number;
  /**
   * Points from the last reveal. Missing when the guest joined after it: show "wait for the
   * next question".
   */
  myPoints?: number;
  score?: number;
  rank?: number;
  /** Rank just before the last reveal, for "▲ 3 places". */
  prevRank?: number;
  /**
   * The places are announced on the big screen first: from the last question's reveal until the
   * host has revealed the whole podium, `rank`, `prevRank` and `score` are left out.
   */
  rankHidden?: boolean;
  /** After the podium, when the host shows it: everyone's place, your own row marked `me`. */
  ranking?: RankRow[];
  /** `ranking` is the overall one, over this many rounds (Phase 6.10). */
  overallRounds?: number;
  /** Top 10 phase: you and up to 3 places above and below you (Phase 6.10). */
  around?: RankRow[];
  /** Waiting room between rounds: how many rounds were played ("the next round starts soon"). */
  roundsPlayed?: number;
  /**
   * This phone is the bride's or the groom's in a round where the couple plays along (Phase 9.5):
   * no place and no points on it ("your answers are shown at the end").
   */
  offBoard?: true;
  /** The couple's review after the podium (the same slide as the big screen's). */
  couple?: CoupleSlide;
}

/** The big screen. */
export interface ScreenView extends QuizViewBase {
  /** Only in the lobby: the title from content/event.json. */
  title?: Localized;
  answeredCount: number;
  /** How many picked each option. Only in the reveal phase. */
  optionCounts?: number[];
  /**
   * Leaderboard: the top 10. Final: only the podium places revealed so far (the host reveals
   * 3rd, 2nd, 1st one by one).
   */
  top?: RankRow[];
  /** The big screen's language, chosen by the host (phones always use their own). */
  lang: Lang;
  /** New guests can join (the host's switch). Closed: the lobby says "Joining opens soon". */
  joiningOpen: boolean;
  /** Final phase: podium places revealed so far (0 to PODIUM_STEPS). */
  podiumShown: number;
  /** A past game shown instead of the live one (Phase 6.8). */
  past?: PastOnScreen;
  /** After the podium, when the host shows it: every player's place (Phase 6.9). */
  ranking?: RankRow[];
  /** `ranking` is the overall one (all rounds added up), over this many rounds (Phase 6.10). */
  overallRounds?: number;
  /** The round's question set, when it isn't the main quiz (e.g. "Poland vs Spain"). */
  roundName?: string;
  /** The couple's review after the podium (Phase 9.5); shown instead of the ranking. */
  couple?: CoupleSlide;
}

/** The host panel: the screen view plus admin-only details. */
export interface HostView extends ScreenView {
  /** The correct option of the current question, also while it runs (host only). */
  answerKey?: number;
  /** Leaderboard and final: the top 10 (in the final also before the podium is revealed). */
  top?: RankRow[];
  /** Guests who picked their name and have an open connection now. */
  connectedGuests: number;
  /** The two sides' names from content/event.json (labels when adding a guest). */
  sides: Record<Side, string>;
  /** The public demo (DEMO_MODE): demo players can be added, photo uploads are off. */
  demo?: true;
  /** The real event, switched from the demo: the host can end it (back to the demo). */
  event?: true;
  /** Problems the host should act on (e.g. saving fails, a rejected snapshot). */
  warnings: string[];
  /** Setup notes, not problems (e.g. the example questions are in use): shown collapsed. */
  notes: string[];
  /** The countdown of every question, in seconds. */
  timeLimitSec: number;
  /** The answer is revealed by itself when the time is up or every active player answered. */
  autoReveal: boolean;
  /** Each question opens with reading time; the host shows the answers (Phase 9.5). */
  readingStep: boolean;
  /** The question list the real quiz plays now (MAIN_SET or a set id). */
  activeSet: string;
  /** Sets whose round was played to the end (marked in the picker). */
  playedSets: string[];
  /** Rounds counted in the overall ranking. */
  roundsPlayed: number;
  /** The overall ranking is on the big screen and the phones. */
  overallShown: boolean;
  /** The bride and groom as marked in guests.json (Phase 9.5), by name. */
  coupleMarked: { bride?: string; groom?: string };
  /**
   * The round being played has "the couple plays along" on and they are marked (Phase 9.5):
   * after the full ranking comes their review.
   */
  coupleRound: boolean;
  /** questions.json has warm-up questions (the host can start a warm-up round). */
  warmupAvailable: boolean;
  /** Guests who picked their name (devices may be offline). */
  joinedGuests: number;
  /** Everyone on the guest list (guests.json + added by the host). */
  guestCount: number;
  /** How long ago the game was last saved, when this view was sent. Missing: not saved yet. */
  savedAgoMs?: number;
  /** The last save failed (disk full, permissions…). */
  saveFailing: boolean;
  /** Where the game is (round, phase, question, podium). Sent back with every step action. */
  step: string;
  /** `step` plus paused or running: sent back with pause and resume. */
  pauseStep: string;
}

/** Host only: a question with its answer, for the host's question list. */
export interface HostQuestion extends PublicQuestion {
  correct: number;
}

/** The real quiz or the warm-up round. */
/**
 * A question list: the main quiz ('questions'), the warm-up ('warmup'), or an extra set of
 * questions for another round (its id, e.g. 'set-ab12', Phase 6.10).
 */
export type QuestionList = string;
/** The main quiz's list (the "questions" of questions.json). */
export const MAIN_SET = 'questions';
/** The warm-up's list. */
export const WARMUP_LIST = 'warmup';
/** Ids of extra question sets. */
export const SET_ID = /^set-[A-Za-z0-9]{2,12}$/;
/** Longest set name. */
export const SET_NAME_MAX = 40;

/** Host only: one list of questions with its answers (the main quiz, the warm-up or a set). */
export interface HostSet {
  id: string;
  name: string;
  questions: HostQuestion[];
  /** The bride and groom answer too, off the leaderboard (Phase 9.5). */
  couple?: boolean;
}

/** Host only, on connect and after every edit: every question list. */
export interface HostQuestionLists {
  questions: HostQuestion[];
  warmup: HostQuestion[];
  /** Extra sets for more rounds (Phase 6.10). */
  sets: HostSet[];
  /** The main quiz: the bride and groom answer too (Phase 9.5). */
  couple?: boolean;
}

/** A round's final scores, kept for the overall ranking (Phase 6.10). */
export interface RoundResult {
  setId: string;
  setName: string;
  finishedAt: number;
  /** Player id → name, points and correct answers in that round. */
  players: Record<string, { name: string; score: number; correctCount: number }>;
}

/** A question as the editor sends it: the server gives new ones their id. */
export type EditedQuestion = Omit<HostQuestion, 'id' | 'timeLimitSec'> & { id?: string };

/** A finished game as saved in data/games (Phase 6.8). Host only: it holds everyone's answers. */
export interface GameRecord {
  version: 1;
  /** The file name without .json: the UTC date and time the game ended, e.g. 2026-09-12T21-15-03Z. */
  id: string;
  finishedAt: number;
  /** The question set played (Phase 6.10; missing in older files = the main quiz). */
  setName?: string;
  timeLimitSec: number;
  questions: ArchivedQuestion[];
  /** Everyone who played, in ranking order. */
  players: ArchivedPlayer[];
  /**
   * The bride and groom when they played along, off the ranking (Phase 9.5); `rank` is where
   * they would have stood. Their answers are in `questions` like everyone's.
   */
  couple?: (ArchivedPlayer & { role: Side })[];
}

export interface ArchivedQuestion extends HostQuestion {
  /** When the question opened (ms since epoch). */
  openedAt: number;
  /** The host skipped it: nobody got points. */
  skipped: boolean;
  /** Every answer given, fastest first. */
  answers: ArchivedAnswer[];
}

export interface ArchivedAnswer {
  playerId: string;
  name: string;
  option: number;
  /** Milliseconds after the question opened (the server's clock). */
  elapsedMs: number;
  points: number;
}

export interface ArchivedPlayer {
  id: string;
  name: string;
  country?: string;
  rank: number;
  score: number;
  correctCount: number;
}

/** One line of the host's "Past games" list. */
export interface GameSummary {
  id: string;
  finishedAt: number;
  playerCount: number;
  questionCount: number;
  /** Everyone on 1st place (a tie can have more). */
  winners: string[];
  /** The question set played, when it wasn't the main quiz (Phase 6.10). */
  setName?: string;
}

/**
 * The big screen shows a past game instead of the live one (host's choice, only in the waiting
 * room or after the quiz): its final ranking, or one question's votes.
 */
export interface PastOnScreen {
  id: string;
  finishedAt: number;
  /** Which question's votes (0-based); missing = the final ranking. */
  question?: number;
  questionCount: number;
  /** The final ranking: the top 10. */
  top?: RankRow[];
  /** One question: the question, how many picked each option, the right one. */
  votes?: { question: PublicQuestion; optionCounts: number[]; correctOption: number };
}

/** Events the server sends to clients. */
export interface ServerToClientEvents {
  'state:guest': (view: GuestView) => void;
  'state:screen': (view: ScreenView) => void;
  'state:host': (view: HostView) => void;
  /** Phones: "62 of 94 have answered" while a question runs (at most once a second). */
  'state:answered': (count: { answeredCount: number; playerCount: number }) => void;
  /** Host only: the whole guest list with claim, online and band status. */
  'state:guests': (rows: HostGuestRow[]) => void;
  /** Host only, on connect: all questions with their answers (the real quiz and the warm-up). */
  'state:questions': (lists: HostQuestionLists) => void;
}

/**
 * Host actions that move the game on carry the step they were tapped at (`HostView.step`): the
 * server refuses them with `stale` once the game has moved on, so a double tap, a second host or
 * a tap replayed after a reconnect can never skip a question.
 */
type StepAction = Action<{ at: string }>;

type Action<P = void, R extends object = object> = P extends void
  ? (ack: (result: Ack<R>) => void) => void
  : (payload: P, ack: (result: Ack<R>) => void) => void;

/** Events clients send to the server. Every one gets an Ack. */
export interface ClientToServerEvents {
  /** Phone: find your name (at least 2 letters). */
  'guest:search': Action<{ query: string }, { results: NameMatch[] }>;
  /** Phone: "this is me". Locks the name to this device. */
  'guest:claim': Action<{ guestId: string }>;
  /** Phone: link your own wristband (scanned or typed code). */
  'collect:claimBand': Action<{ code: string }>;
  /** The question id is checked, so a late tap can never count for the next question. */
  'quiz:answer': Action<{ option: number; questionId: string }>;
  /** Phone: "Not you? Change name". Only your own name, only before the quiz starts. */
  'guest:unclaim': Action;
  'host:start': StepAction;
  'host:next': StepAction;
  'host:skip': StepAction;
  /** Pause and resume carry `HostView.pauseStep`, so a double tap can't pause and resume again. */
  'host:pause': StepAction;
  'host:resume': StepAction;
  'host:addTime': Action<{ ms: number }>;
  'host:restart': StepAction;
  /** Opens or closes joining for new guests (devices that already picked a name stay in). */
  'host:setJoining': Action<{ open: boolean }>;
  /** The countdown of every question, TIMER_MIN_SEC to TIMER_MAX_SEC. Waiting room only. */
  'host:setTimer': Action<{ sec: number }>;
  /** Starts a warm-up round (3 practice questions, no points count). Only in the lobby. */
  'host:startWarmup': StepAction;
  /** Ends the warm-up round: everyone is back in the lobby of the real quiz. */
  'host:endWarmup': StepAction;
  /** The big screen's language. */
  'host:setScreenLang': Action<{ lang: Lang }>;
  /** Final: reveals the next podium place on the big screen (3rd, then 2nd, then 1st). */
  'host:podiumNext': StepAction;
  /** After the podium: everyone's place on the big screen (scrolling) and on every phone. */
  'host:showRanking': StepAction;
  /** Auto-reveal on or off (saved). */
  'host:setAutoReveal': Action<{ on: boolean }>;
  /** Reading time before the answers (Phase 9.5), from the next question on. */
  'host:setReadingStep': Action<{ on: boolean }>;
  /** Reading time is over: the answers appear and the countdown starts. */
  'host:showAnswers': StepAction;
  /** Switches "the couple plays along" for the main quiz or a set (waiting room only). */
  'host:setCouple': Action<{ list: QuestionList; on: boolean }>;
  /** The couple's review after the full ranking: the next slide (then the summary). */
  'host:coupleNext': StepAction;
  /** Removes a guest the host added: name, player and score go (asks first in the panel). */
  'host:removeGuest': Action<{ guestId: string }>;
  /** Demo only: adds up to 8 demo players who join and answer by themselves. */
  'host:addBots': Action<void, { added: number }>;
  /** Event mode only: back to the public demo (the server restarts; the event's data stays). */
  'host:endEvent': Action;
  /** Question sets (waiting room only): create, rename, delete, and pick the one to play. */
  'host:setCreate': Action<{ name: string }, { id: string }>;
  'host:setRename': Action<{ id: string; name: string }>;
  'host:setDelete': Action<{ id: string }>;
  'host:selectSet': Action<{ id: string }>;
  /** The overall ranking (all rounds added up) on the big screen and phones, or not. */
  'host:showOverall': Action<{ on: boolean }>;
  /** Forgets the rounds played so far (e.g. after test rounds): the overall ranking starts again. */
  'host:resetOverall': Action;
  /** Frees a name picked by mistake: that device goes back to the name search. Score stays. */
  'host:releaseGuest': Action<{ guestId: string }>;
  /**
   * Question editor (waiting room only): saves a new question (no id; placed at `index`, default
   * at the end) or replaces the one with that id. Replies with the question's id.
   */
  'host:questionSave': Action<
    { list: QuestionList; question: EditedQuestion; index?: number },
    { id: string }
  >;
  'host:questionDelete': Action<{ list: QuestionList; id: string }>;
  /** Moves a question to position `to` (0-based) in its list. */
  'host:questionMove': Action<{ list: QuestionList; id: string; to: number }>;
  /** Emergency (strangers took names): frees every name picked in the last N minutes. */
  'host:releaseRecent': Action<{ minutes: number }, { released: number }>;
  /** Host: the saved games, newest first (Phase 6.8). */
  'host:games': Action<void, { games: GameSummary[] }>;
  /** Host: one saved game with every answer. */
  'host:game': Action<{ id: string }, { game: GameRecord }>;
  /** Host: deletes a saved game (the file in data/games). */
  'host:gameDelete': Action<{ id: string }>;
  /**
   * Host: shows a past game on the big screen (its ranking, or question `question`'s votes), or
   * the live game again (`id: null`). Only in the waiting room or after the quiz.
   */
  'host:showPast': Action<{ id: string | null; question?: number }>;
  /** Adds a guest missing from the list. `duplicate-name` unless allowDuplicate (namesakes). */
  'host:addGuest': Action<
    { name: string; country: string; side: Side; allowDuplicate?: boolean },
    { guestId: string }
  >;
  /** Unlinks a wristband (wrong band claimed). Collected points stay. */
  'host:unlinkBand': Action<{ code: string }>;
}

/** Error message of a refused Socket.IO connection (no valid login or guest session). */
export const UNAUTHORIZED = 'unauthorized';
/** Error message of a refused Socket.IO connection: too many open from this device or network. */
export const TOO_MANY_CONNECTIONS = 'too-many-connections';
