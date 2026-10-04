// Game rules in one place. Change numbers here, not in the logic.

/** Points for a correct answer at the very start of the countdown. */
export const MAX_POINTS = 1000;
/** Points for a correct answer in the last moment of the countdown. */
export const MIN_POINTS = 500;
/** The countdown until the host sets another one (questions.json `timeLimitSec`). */
export { TIMER_DEFAULT_SEC as DEFAULT_TIME_LIMIT_SEC } from '@idoknow/shared';

/** Collect mode: points for collecting any guest. */
export const COLLECT_BASE_POINTS = 10;
/** Collect mode: bonus when the collected guest is from another country. */
export const COLLECT_OTHER_COUNTRY_BONUS = 10;
/** Collect mode: bonus when the collected guest is from the other side of the family. */
export const COLLECT_OTHER_SIDE_BONUS = 10;
/** Collect mode rate limit: at most this many successful scans… */
export const COLLECT_RATE_MAX = 5;
/** …within this window per collector. */
export const COLLECT_RATE_WINDOW_MS = 60_000;

/** Late-tap grace (defined in the shared package: the phone needs it too). */
export { ANSWER_GRACE_MS } from '@idoknow/shared';

/** Largest single "+time" the host can add, in ms. */
export const ADD_TIME_MAX_MS = 60_000;
/** All extra time of one question together: 10 minutes (audit 9: never unbounded). */
export const EXTRA_TIME_TOTAL_MAX_MS = 600_000;
/**
 * Collect mode: at most this many failed scans (wrong or unknown codes) per window per guest,
 * so nobody can guess codes. Repeated scans of real wristbands don't count.
 */
export const COLLECT_FAILED_MAX = 20;
/** Wristband codes: letters and digits only, at most this long. */
export const BAND_CODE_MAX_LENGTH = 16;

/** Admin login: failed attempts allowed per IP within the window. */
export const LOGIN_FAILS_PER_IP_MAX = 10;
export const LOGIN_WINDOW_MS = 15 * 60_000;
/** Memory bound for every rate limiter: keys (IPs, sessions) remembered at most. */
export const RATE_LIMIT_MAX_KEYS = 10_000;

/** Name search: typed letters needed before searching… */
export const SEARCH_MIN_CHARS = 2;
/** …results returned at most… */
export const SEARCH_MAX_RESULTS = 8;
/** …and searches per phone (session) within the window (the phone debounces typing)… */
export const SEARCH_RATE_MAX = 30;
export const SEARCH_RATE_WINDOW_MS = 10_000;
/**
 * …and per IP per minute. Very generous, because all guests on the venue Wi-Fi (or behind one
 * mobile carrier) can share one IP, and one person must not be able to block them all. It only
 * stops a script from reading the list at full speed; hitting it warns the host.
 */
export const SEARCH_PER_IP_PER_MINUTE = 1500;
/** Name claims per IP per minute: more than all guests at once; hitting it warns the host. */
export const CLAIM_PER_IP_PER_MINUTE = 150;
/** Longest guest name (list file or added by the host). */
export const GUEST_NAME_MAX_LENGTH = 80;

/** Largest Socket.IO message a client may send, in bytes (one edited question in 5 languages fits). */
export const SOCKET_MAX_MESSAGE_BYTES = 32_000;
/** The screen and host get answer-count updates at most this often. */
export const ANSWER_COUNT_THROTTLE_MS = 250;
/** Snapshots after answers are written at most this often. */
export const SNAPSHOT_DEBOUNCE_MS = 1_000;

/** "Release names picked in the last N minutes" (host, strangers took names): at most this N. */
export const RELEASE_RECENT_MAX_MINUTES = 240;

/**
 * Open phone connections at most per device (session) and per IP bucket. Anyone can open the
 * join link, so without a cap one script could fill the server's memory with sockets. The IP cap
 * is generous: every guest on the venue Wi-Fi can share one IP.
 */
export const SOCKETS_PER_SESSION_MAX = 10;
export const SOCKETS_PER_IP_MAX = 300;

/**
 * Auto-reveal (Phase 6.9): a player counts as taking part while they answered at least one of
 * the last ACTIVE_WINDOW questions (so a guest who stopped playing never holds up the reveal).
 */
export const ACTIVE_WINDOW = 2;
/** When every active player has answered, the answer is revealed this much later (their ✓ first). */
export const ALL_ANSWERED_BEAT_MS = 1_500;
/** Demo players answer this many ms after the answers appear (a random time in between). */
export const BOT_ANSWER_MS: [number, number] = [1_500, 9_000];
/** How often a demo player picks the right answer. */
export const BOT_RIGHT_SHARE = 0.65;
/** The demo players: made-up names (name, country, side). */
export const BOT_PEOPLE: readonly [string, string, 'bride' | 'groom'][] = [
  ['Marta Kowalska', 'PL', 'bride'],
  ['Pablo Ruiz', 'ES', 'groom'],
  ['Lena Schmidt', 'DE', 'bride'],
  ['Ola Nowak', 'PL', 'bride'],
  ['Carmen Vidal', 'ES', 'groom'],
  ['Jonas Weber', 'DE', 'groom'],
  ['Kasia Zielińska', 'PL', 'bride'],
  ['Marc Puig', 'ES', 'groom'],
];
