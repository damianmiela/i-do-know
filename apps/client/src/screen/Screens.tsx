// What the big screen shows in each phase (after the approved mockup docs/mockups/screen.html).
// Motion (Phase 6.5): each screen decides once, when it appears, whether it animates (useAnimate),
// and the CSS animations live under its `.anim` class (screen.css).
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  JOIN_PATH,
  PODIUM_STEPS,
  type CoupleSlide,
  type Lang,
  type Localized,
  type PastOnScreen,
  type QuestionKind,
  type RankRow,
  type ScreenView,
} from '@idoknow/shared';
import { formatDateTime, formatNumber } from '../i18n';
import { prefersReducedMotion, useAnimate, useCountUp } from '../motion';
import { CountryFlag, Icon, LangFlag } from '../play/Icon';
import { rankMove, secondsShown, symbolFor, timeLeft, timeShare } from '../play/logic';
import {
  answeredShare,
  capNames,
  confetti,
  isLocalOnly,
  isNewcomer,
  joinText,
  podiumSlots,
  rankingScroll,
  startSlots,
  textFit,
  voteHeights,
} from './logic';
import { Qr } from './Qr';
import { st, type ScreenKey } from './texts';

interface BoardProps {
  view: ScreenView;
  /** performance.now() when `view` arrived, for the local countdown. */
  receivedAt: number;
  now: number;
}

const photoUrl = (name: string) => `/photos/${encodeURIComponent(name)}`;
const inLang = (text: Localized, lang: Lang) => text[lang] || text.en;
/** The join link (QR code): this page's own address, so it works for the domain and a test IP. */
const joinUrl = () => window.location.origin + JOIN_PATH;
/** The languages under "Scan to play" in the lobby: the guests' three countries. */
const SCAN_LANGS: readonly Lang[] = ['pl', 'es', 'de'];

/** The screen's texts in the language the host chose. */
const textFor =
  (view: ScreenView) =>
  (key: ScreenKey, vars?: Record<string, string | number>): string =>
    st(view.lang, key, vars);

export function Board(props: BoardProps) {
  const { view } = props;
  if (view.past) return <Past view={view} past={view.past} />;
  switch (view.phase) {
    case 'lobby':
      // the overall ranking between rounds (Phase 6.10), else the waiting room
      return view.ranking ? <FullRanking view={view} rows={view.ranking} /> : <Lobby view={view} />;
    case 'question':
      return <Question {...props} />;
    case 'reveal':
      return <Reveal view={view} />;
    case 'leaderboard':
      return <Leaderboard view={view} />;
    case 'final':
      // after the full ranking, the couple's answers (Phase 9.5)
      if (view.couple) return <CoupleReview view={view} slide={view.couple} />;
      // the warm-up plays the podium too (Phase 6.10: "so people know what's up")
      return view.ranking ? (
        <FullRanking view={view} rows={view.ranking} />
      ) : (
        <Podium view={view} />
      );
  }
}

/**
 * The couple's review (Phase 9.5): each question with the right answer and where the bride (♥)
 * and the groom (★) put theirs, then how well they did.
 */
function CoupleReview({ view, slide }: { view: ScreenView; slide: CoupleSlide }) {
  const text = textFor(view);
  const animate = useAnimate();
  const q = slide.question;
  const same = slide.bride?.option !== undefined && slide.bride.option === slide.groom?.option;
  return (
    <div className={`s-page s-couple${animate ? ' anim' : ''}`}>
      <Header view={view}>
        <h2 className="s-h2">{text('coupleTitle')}</h2>
        {slide.n !== undefined && (
          // beside the long title, not centred over it
          <span className="s-chip gold">
            {text('afterQuestion', { n: slide.n, total: slide.total })}
          </span>
        )}
      </Header>
      {q ? (
        <div className={`s-couple-q${q.photo ? ' with-photo' : ''}`}>
          {q.photo && <img className="s-photo" src={photoUrl(q.photo)} alt="" />}
          <div className="s-couple-main">
            <p className="s-q small" lang={view.lang}>
              {inLang(q.text, view.lang)}
            </p>
            <div className="s-couple-opts">
              {q.options.map((o, i) => {
                const symbol = symbolFor(q.kind, i);
                return (
                  <div
                    key={i}
                    className={`s-couple-opt ${symbol}${i === q.correct ? ' right' : ''}`}
                  >
                    <Icon name={symbol} className="sym" />
                    <span className="label">{inLang(o, view.lang)}</span>
                    <span className="picks">
                      {slide.bride?.option === i && (
                        <span className="s-pick bride">
                          <Icon name="heart" className="ic" />
                          {slide.bride.name}
                        </span>
                      )}
                      {slide.groom?.option === i && (
                        <span className="s-pick groom">
                          <Icon name="star" className="ic" />
                          {slide.groom.name}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="s-couple-line">
              {same
                ? text('sameAnswer')
                : [slide.bride, slide.groom]
                    .filter((p) => p && p.option === undefined)
                    .map((p) => `${p!.name}: ${text('noAnswer')}`)
                    .join(' · ')}
            </p>
          </div>
        </div>
      ) : (
        slide.summary && (
          <div className="s-couple-sum">
            {(['bride', 'groom'] as const).map((role) => {
              const who = slide.summary![role];
              if (!who) return null;
              return (
                <div key={role} className={`s-couple-card ${role}`}>
                  <Icon name={role === 'bride' ? 'heart' : 'star'} className="sym" />
                  <b>{who.name}</b>
                  <span className="big">
                    {text('rightOf', { n: who.correct, total: slide.total })}
                  </span>
                  {who.wouldRank !== undefined && (
                    <small>{text('placeFun', { n: who.wouldRank })}</small>
                  )}
                </div>
              );
            })}
            {slide.summary.bride && slide.summary.groom && (
              <p className="s-couple-agreed">
                {text('agreed', { n: slide.summary.agreed, total: slide.total })}
              </p>
            )}
          </div>
        )
      )}
    </div>
  );
}

/**
 * A past game the host chose (Phase 6.8): its Top 10, or one question's votes, drawn by the same
 * screens as the live game, with a label saying which game it is.
 */
function Past({ view, past }: { view: ScreenView; past: PastOnScreen }) {
  const shown: ScreenView = past.votes
    ? {
        ...view,
        phase: 'reveal',
        question: past.votes.question,
        optionCounts: past.votes.optionCounts,
        correctOption: past.votes.correctOption,
        questionNumber: (past.question ?? 0) + 1,
        questionCount: past.questionCount,
      }
    : {
        ...view,
        phase: 'leaderboard',
        top: past.top ?? [],
        questionNumber: past.questionCount,
        questionCount: past.questionCount,
      };
  return (
    <>
      <span className="s-past">
        {textFor(view)('pastGame', { date: formatDateTime(view.lang, past.finishedAt) })}
      </span>
      {past.votes ? <Reveal view={shown} /> : <Leaderboard view={shown} />}
    </>
  );
}

/**
 * After the podium (Phase 6.9): everyone's place, in an endless loop: 5 s at the top, a slow
 * scroll to the bottom, 5 s there, quickly back up (rankingScroll). Moved by transform, straight
 * on the element, so the list never re-renders while it scrolls.
 */
function FullRanking({ view, rows }: { view: ScreenView; rows: RankRow[] }) {
  const text = textFor(view);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const still = prefersReducedMotion();
    const started = performance.now();
    let frame = 0;
    let last = NaN;
    const tick = (now: number) => {
      const b = box.current;
      const l = list.current;
      if (b && l) {
        const max = l.offsetHeight - b.clientHeight;
        const y = Math.round(rankingScroll(now - started, max, b.clientHeight - ROW_PITCH, still));
        // a list that fits (or a pause, or "reduce motion" between pages): no style writes
        if (y !== last) l.style.transform = `translateY(${-y}px)`;
        last = y;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [rows.length]);
  return (
    <div className="s-page">
      <Header view={view}>
        <h2 className="s-h2">
          {view.overallRounds
            ? `${text('overall')} · ${text('roundsN', { n: view.overallRounds })}`
            : text('fullRanking')}
        </h2>
      </Header>
      <div className="s-full" ref={box}>
        <div className="s-full-list" ref={list}>
          {rows.map((r, i) => (
            <div key={i} className={`s-row${r.rank <= 3 && r.score > 0 ? ' top' : ''}`}>
              <span className="pos num">{r.rank}</span>
              {r.country ? <CountryFlag code={r.country} /> : <span />}
              <span className="name">{r.name}</span>
              <span className="pts num">{formatNumber(view.lang, r.score)}</span>
              <span />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Timings (ms) shared by the components and screen.css. */
const T = {
  votes: 600, // the vote bars start growing
  votesFor: 1400,
  rows: 1100, // the Top 10 rows start sliding
  rowsFor: 1400,
};

function Lobby({ view }: { view: ScreenView }) {
  const text = textFor(view);
  // ticks up as guests join (and simply shows the number after a reconnect)
  const [still] = useState(prefersReducedMotion);
  const count = useCountUp(view.playerCount, { duration: 900, animate: !still });
  return (
    <div className="s-lobby">
      {view.joiningOpen ? (
        <div className="s-join">
          <div className="qr-card breathe">
            <Qr text={joinUrl()} px={500} />
          </div>
          {/* for guests who can't scan: short enough to type */}
          <span className="s-url">{joinText(window.location.host)}</span>
          <div className="s-scan">
            {SCAN_LANGS.map((l) => (
              <span key={l} lang={l}>
                <LangFlag lang={l} />
                {st(l, 'scanToPlay')}
              </span>
            ))}
          </div>
          <LocalWarning />
        </div>
      ) : (
        // the host opens joining when it's time (before that, phones see "too early")
        <div className="s-join">
          <div className="s-soon breathe">
            <Icon name="heart" className="sym" />
            {SCAN_LANGS.map((l) => (
              <span key={l} lang={l}>
                <LangFlag lang={l} />
                {st(l, 'joiningSoon')}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="s-welcome">
        <img className="s-logo" src="/brand/wordmark-light.webp" alt="I Do! (know)" />
        <h1 className="s-title">{view.title?.[view.lang]}</h1>
        {view.roundName && <p className="s-round">{view.roundName}</p>}
        <div className="s-count">
          <span className="num">{formatNumber(view.lang, count)}</span>
          <span>{text('joined', { n: view.playerCount })}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Opened at localhost, the QR code leads nowhere for phones: tell the host (English, the host
 * reads it) to open the screen at the computer's network address or the domain.
 */
function LocalWarning() {
  if (!isLocalOnly(window.location.hostname)) return null;
  return (
    <p className="s-local" role="alert">
      Phones can&apos;t open {window.location.host}. Open this screen at the computer&apos;s network
      address (e.g. http://192.168.1.23:3210/screen) or the real domain.
    </p>
  );
}

/** "62 / 94 answered", with a bar that fills as the answers come in. */
function Answered({ view }: { view: ScreenView }) {
  const text = textFor(view);
  const share = answeredShare(view.answeredCount, view.playerCount);
  return (
    <div className="s-answered" role="status">
      <span className="num">
        {formatNumber(view.lang, view.answeredCount)}
        <small> / {formatNumber(view.lang, view.playerCount)}</small>
      </span>
      <span className="s-answered-label">{text('answeredWord')}</span>
      <i className="s-answered-bar" aria-hidden="true">
        <b style={{ width: `${share * 100}%` }} />
      </i>
    </div>
  );
}

/** "Practice round" badge: the warm-up's points don't count. */
function Practice({ view }: { view: ScreenView }) {
  return <span className="s-practice">{textFor(view)('practice')}</span>;
}

/** Top bar during the quiz: question number, practice badge, a small join QR for lost phones. */
function Header({ view, children }: { view: ScreenView; children?: ReactNode }) {
  const text = textFor(view);
  return (
    <header className="s-bar">
      <div className="s-bar-start">
        {(view.phase === 'question' || view.phase === 'reveal') && (
          <span className="s-chip">
            {text('questionOf', { n: view.questionNumber, total: view.questionCount })}
          </span>
        )}
        {view.warmup && <Practice view={view} />}
        {children}
      </div>
      {view.joiningOpen && (
        <div className="s-lost">
          <span>
            {text('lost')}
            <small className="s-lost-url">{joinText(window.location.host)}</small>
          </span>
          <div className="qr-card small">
            <Qr text={joinUrl()} px={132} />
          </div>
        </div>
      )}
    </header>
  );
}

function Clock({ view, receivedAt, now }: BoardProps) {
  const left = timeLeft(view, receivedAt, now);
  const limit = view.question?.timeLimitSec ?? 20;
  const share = timeShare(left, limit);
  return (
    <div
      className={`s-clock${left <= 5_000 && !view.paused ? ' ending' : ''}`}
      style={{ '--share': `${share * 360}deg` } as CSSProperties}
      aria-label={view.paused ? textFor(view)('paused') : undefined}
    >
      <span className="num">{view.paused ? '❚❚' : secondsShown(left)}</span>
    </div>
  );
}

/** One answer tile: colour + symbol + text, the same colours and symbols as on the phones. */
function Tile({
  kind,
  index,
  label,
  className = '',
}: {
  kind: QuestionKind;
  index: number;
  label: string;
  className?: string;
}) {
  const symbol = symbolFor(kind, index);
  return (
    <div className={`s-ans ${symbol} ${className}`}>
      <Icon name={symbol} className="sym" />
      <span>{label}</span>
    </div>
  );
}

function Question(props: BoardProps) {
  const { view } = props;
  const text = textFor(view);
  const animate = useAnimate();
  const q = view.question;
  if (!q) return null;
  return (
    <div className={`s-page${animate ? ' anim' : ''}`}>
      <Header view={view}>
        {!view.reading && <Answered view={view} />}
        {view.paused && <span className="s-chip gold">{text('paused')}</span>}
      </Header>
      <div
        className={`s-question${q.photo ? ' with-photo' : ''} ${textFit(
          inLang(q.text, view.lang),
          q.options.map((o) => inLang(o, view.lang)),
        )}`}
      >
        {q.photo && <img className="s-photo" src={photoUrl(q.photo)} alt="" />}
        <div className="s-q-main">
          <div className="s-q-head">
            {!view.reading && <Clock {...props} />}
            <p className="s-q" lang={view.lang}>
              {inLang(q.text, view.lang)}
            </p>
          </div>
          {view.reading ? (
            // reading time (Phase 9.5): the answers come when the host shows them, for everyone
            <p className="s-reading" role="status">
              {text('answersSoon')}
            </p>
          ) : (
            <div className={`s-answers${q.options.length === 2 ? ' duo' : ''}`}>
              {q.options.map((o, i) => (
                <Tile key={i} kind={q.kind} index={i} label={inLang(o, view.lang)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Reveal({ view }: { view: ScreenView }) {
  const animate = useAnimate();
  const q = view.question;
  const correct = view.correctOption;
  if (!q || correct === undefined) return null;
  const counts = view.optionCounts ?? q.options.map(() => 0);
  const heights = voteHeights(counts, 280);
  return (
    <div className={`s-page${animate ? ' anim' : ''}`}>
      <Header view={view} />
      <div
        className={`s-reveal${q.photo ? ' with-photo' : ''} ${textFit(
          inLang(q.text, view.lang),
          q.options.map((o) => inLang(o, view.lang)),
        )}`}
      >
        {q.photo && <img className="s-photo" src={photoUrl(q.photo)} alt="" />}
        <div className="s-reveal-main">
          <p className="s-q small" lang={view.lang}>
            {inLang(q.text, view.lang)}
          </p>
          <div className="s-votes">
            {counts.map((n, i) => {
              const symbol = symbolFor(q.kind, i);
              return (
                <div key={i} className={`s-vote ${symbol}${i === correct ? ' right' : ''}`}>
                  <Counted
                    n={n}
                    lang={view.lang}
                    animate={animate}
                    delay={T.votes}
                    duration={T.votesFor}
                  />
                  <i style={{ height: heights[i] }} />
                  <Icon name={symbol} className="sym" />
                </div>
              );
            })}
          </div>
          <Tile
            kind={q.kind}
            index={correct}
            label={inLang(q.options[correct]!, view.lang)}
            className="right"
          />
        </div>
      </div>
    </div>
  );
}

/** A number that counts up from `from` (0 by default) while the screen animates. */
function Counted({
  n,
  from = 0,
  lang,
  animate,
  delay,
  duration,
  className = 'num',
}: {
  n: number;
  from?: number;
  lang: Lang;
  animate: boolean;
  delay: number;
  duration: number;
  className?: string;
}) {
  const value = useCountUp(n, { from, delay, duration, animate });
  return <span className={className}>{formatNumber(lang, value)}</span>;
}

/** Row height + gap of the Top 10 (screen.css), for sliding rows from their old place. */
const ROW_PITCH = 76;

function Leaderboard({ view }: { view: ScreenView }) {
  const text = textFor(view);
  const animate = useAnimate();
  const rows = view.top ?? [];
  // the list opens in the old order, then every row slides to its new place
  const slots = startSlots(rows);
  return (
    <div className={`s-page${animate ? ' anim' : ''}`}>
      <Header view={view}>
        <h2 className="s-h2">{text('top')}</h2>
        {/* big and centred (Damian): how far the quiz is */}
        <span className="s-progress">
          {text('afterQuestion', { n: view.questionNumber, total: view.questionCount })}
        </span>
      </Header>
      <div className="s-board">
        {rows.map((r, i) => {
          const move = rankMove(r.prevRank, r.rank);
          const fresh = isNewcomer(r);
          const from = fresh ? (rows.length - i) * ROW_PITCH + 40 : (slots[i]! - i) * ROW_PITCH;
          return (
            <div
              key={i}
              className={`s-row${r.rank <= 3 ? ' top' : ''}${fresh ? ' fresh' : ''}`}
              style={{ '--from': `${from}px` } as CSSProperties}
            >
              <span className="pos num">
                {/* the old place while the row still stands there, then the new one */}
                {animate && !fresh && r.prevRank !== undefined && r.prevRank !== r.rank && (
                  <span className="old">{r.prevRank}</span>
                )}
                <span className="new">{r.rank}</span>
              </span>
              {r.country ? <CountryFlag code={r.country} /> : <span />}
              <span className="name">{r.name}</span>
              <Counted
                className="pts num"
                n={r.score}
                from={r.score - (r.gained ?? 0)}
                lang={view.lang}
                animate={animate}
                delay={T.rows}
                duration={T.rowsFor}
              />
              <span className={`mv ${move ? (move > 0 ? 'up' : 'down') : 'same'}`}>
                {move ? (
                  <>
                    <Icon name={move > 0 ? 'up' : 'down'} />
                    {Math.abs(move)}
                  </>
                ) : (
                  '–'
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Confetti colours: the answer colours and the gold (theme.css). */
const CONFETTI_COLORS = ['--gold', '--c-heart', '--c-flower', '--c-star', '--c-moon', '--ivory'];
const PIECES = confetti(90, CONFETTI_COLORS.length);
/** Start delay + the longest fall (confetti() delays up to 1.6 s, falls up to 4.8 s) + a margin. */
const CONFETTI_MS = 1600 + 1600 + 4800 + 1000;

function Podium({ view }: { view: ScreenView }) {
  const text = textFor(view);
  const animate = useAnimate();
  // places already out when this screen appeared (after a reconnect) stand still
  const [calm] = useState(() => (animate ? 0 : view.podiumShown));
  const slots = podiumSlots(view.top ?? [], view.podiumShown);
  const winner = slots.find((s) => s.place === 1);
  const cheer = !!winner?.shown && winner.rows.length > 0 && calm < PODIUM_STEPS;
  // the confetti has fallen after a few seconds: take it out of the page again
  const [confettiDone, setConfettiDone] = useState(false);
  useEffect(() => {
    if (!cheer) return;
    const t = setTimeout(() => setConfettiDone(true), CONFETTI_MS);
    return () => clearTimeout(t);
  }, [cheer]);
  return (
    <div className="s-page">
      <Header view={view}>
        <h2 className="s-h2">{text('winner')}</h2>
      </Header>
      {view.warmup && view.podiumShown >= PODIUM_STEPS && (
        <p className="s-lead s-practice-next">
          {text('practiceDone')} {text('practiceNext')}
        </p>
      )}
      <div className="s-podium">
        {slots.map((slot) => {
          const out = slot.shown && slot.rows.length > 0;
          const enter = out && slot.place <= PODIUM_STEPS - calm;
          return (
            <div
              key={slot.place}
              className={`s-pod p${slot.place}${out ? ' shown' : ''}${enter ? ' enter' : ''}`}
            >
              <div className="who">{out && <PodiumNames view={view} rows={slot.rows} />}</div>
              <div className="blk num">{slot.place}</div>
            </div>
          );
        })}
      </div>
      {cheer && !confettiDone && !prefersReducedMotion() && (
        <div className="s-confetti" aria-hidden="true">
          {PIECES.map((p, i) => (
            <i
              key={i}
              className={p.wide ? 'wide' : ''}
              style={
                {
                  left: `${p.left}%`,
                  background: `var(${CONFETTI_COLORS[p.color]})`,
                  animationDelay: `${1600 + p.delay}ms`,
                  animationDuration: `${p.duration}ms`,
                  '--drift': `${p.drift}px`,
                  '--spin': `${p.spin}deg`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PodiumNames({ view, rows }: { view: ScreenView; rows: RankRow[] }) {
  const { shown, more } = capNames(rows);
  return (
    <>
      {shown.map((r, i) => (
        <span key={i} className="winner">
          <span className="name">{r.name}</span>
          {r.country && <CountryFlag code={r.country} />}
          <span className="pts num">{formatNumber(view.lang, r.score)}</span>
        </span>
      ))}
      {more > 0 && <span className="pts num">+{formatNumber(view.lang, more)}</span>}
    </>
  );
}
