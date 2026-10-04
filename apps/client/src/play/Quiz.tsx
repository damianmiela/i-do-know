// The quiz on the phone: waiting room, question (also after answering), time's up, reveal,
// leaderboard, final. The same screens play the warm-up round, with a "practice round" badge.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { CoupleSlide, GuestView, Localized, QuestionKind, RankRow } from '@idoknow/shared';
import type { Key } from '../i18n';
import { formatNumber } from '../i18n';
import { useAnimate, useCountUp } from '../motion';
import { socket } from '../socket';
import { useLang, useText, type ScreenProps } from './context';
import { Icon } from './Icon';
import {
  isLongText,
  rankMove,
  REPLY_TIMEOUT_MS,
  secondsShown,
  SLOW_REPLY_MS,
  startRows,
  symbolFor,
  timeLeft,
  timeShare,
} from './logic';

const photoUrl = (name: string) => `/photos/${encodeURIComponent(name)}`;
const inLang = (text: Localized, lang: keyof Localized) => text[lang] || text.en;

/** Shown on every screen of the warm-up round. */
function PracticeBadge({ view }: { view: GuestView }) {
  const text = useText();
  return view.warmup ? <p className="practice">{text('practice')}</p> : null;
}

export function Lobby({ view, onAck }: ScreenProps) {
  // download the quiz photos quietly now, so photo questions show at once later (also while
  // the overall ranking is shown between rounds: audit 9)
  const photos = view.photos?.join('|') ?? '';
  useEffect(() => {
    for (const name of photos ? photos.split('|') : []) {
      const img = new Image();
      img.decoding = 'async';
      img.src = photoUrl(name);
    }
  }, [photos]);
  // between rounds the host may show the overall ranking (Phase 6.10)
  if (view.ranking) return <FullRanking view={view} rows={view.ranking} />;
  return <WaitingRoom view={view} onAck={onAck} />;
}

function WaitingRoom({ view, onAck }: Pick<ScreenProps, 'view' | 'onAck'>) {
  const text = useText();
  const [message, setMessage] = useState<Key | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // "Not you?": back to the name search (only before the quiz starts)
  const changeName = () => {
    setBusy(true);
    socket.timeout(REPLY_TIMEOUT_MS).emit('guest:unclaim', (err, reply) => {
      setBusy(false);
      setConfirming(false);
      if (err) return setMessage('error');
      if (!onAck(reply).ok) {
        // joining closed: the phone could never pick a name again, so only the host helps
        setMessage(!reply.ok && reply.error === 'joining-closed' ? 'askHost' : 'error');
      }
    });
  };

  // one extra tap, so a stray finger doesn't give the name away
  if (confirming) {
    return (
      <div className="grow center">
        <h1 className="h-phone">{text('changeNameTitle')}</h1>
        <div className="surface wide confirm-name">
          <span className="big-name">{view.name}</span>
        </div>
        <button className="btn" disabled={busy} onClick={changeName}>
          {text('changeNameYes')}
        </button>
        <button className="btn quiet" disabled={busy} onClick={() => setConfirming(false)}>
          {text('confirmNo')}
        </button>
      </div>
    );
  }

  return (
    <div className="grow center">
      <img className="logo-big" src="/brand/logo-light.webp" alt="I Do! (know)" />
      <h1 className="h-phone">{text('inTitle')}</h1>
      <p className="lead">{text(view.roundsPlayed ? 'nextRoundLead' : 'inLead')}</p>
      <div className="surface wide">
        <span className="caption">{text('playersJoined')}</span>
        <span className="num big">{view.playerCount}</span>
      </div>
      {message && (
        <p className="notice" role="alert">
          {text(message)}
        </p>
      )}
      <button className="link-button" onClick={() => setConfirming(true)}>
        {text('changeName')}
      </button>
    </div>
  );
}

function Countdown({ view, receivedAt, now }: Pick<ScreenProps, 'view' | 'receivedAt' | 'now'>) {
  const text = useText();
  const left = timeLeft(view, receivedAt, now);
  const limit = view.question?.timeLimitSec ?? 20;
  return (
    <>
      <div className="bar">
        <span className="bar-count">
          {text('nOfTotal', { n: view.questionNumber, total: view.questionCount })}
        </span>
        {/* reading time: no seconds yet, the clock starts with the answers */}
        {!view.reading && (
          <span className="chip gold num">
            {view.paused ? text('paused') : text('seconds', { n: secondsShown(left) })}
          </span>
        )}
      </div>
      <div className="timer" aria-hidden="true">
        <i style={{ width: `${timeShare(left, limit) * 100}%` }} />
      </div>
    </>
  );
}

/** One answer tile: colour + symbol + text. */
function Answer({
  kind,
  index,
  label,
  className = '',
  onClick,
  disabled,
  mark,
}: {
  kind: QuestionKind;
  index: number;
  label: string;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** A ✓ in the corner: the guest's saved answer. */
  mark?: boolean;
}) {
  const symbol = symbolFor(kind, index);
  const content = (
    <>
      <Icon name={symbol} className="sym" />
      <span>{label}</span>
      {mark && (
        <span className="mark">
          <Icon name="check" />
        </span>
      )}
    </>
  );
  return onClick ? (
    <button className={`ans ${symbol} ${className}`} onClick={onClick} disabled={disabled}>
      {content}
    </button>
  ) : (
    <div className={`ans ${symbol} ${className}`}>{content}</div>
  );
}

/** A small chip with an answer's symbol and text (reveal: "the answer was", "you chose"). */
function AnswerChip({ kind, index, label }: { kind: QuestionKind; index: number; label: string }) {
  const symbol = symbolFor(kind, index);
  return (
    <span className={`chip answer-chip ${symbol}`}>
      <Icon name={symbol} />
      {label}
    </span>
  );
}

/** Mounted once per question (key), so nothing from the previous question lingers. */
export function QuestionScreen({ view, receivedAt, now, connected, onAck }: ScreenProps) {
  const text = useText();
  const lang = useLang();
  const [pending, setPending] = useState<number | null>(null);
  const [slow, setSlow] = useState(false);
  const [message, setMessage] = useState<Key | null>(null);
  const q = view.question;

  // a connection lost while a tap was on its way: the server's next view says whether it
  // arrived (then "answer saved"); otherwise the guest can simply tap again
  useEffect(() => {
    const lost = () => setPending(null);
    socket.on('disconnect', lost);
    return () => {
      socket.off('disconnect', lost);
    };
  }, []);
  // no reply after a few seconds: say that we're still trying
  useEffect(() => {
    if (pending === null) return;
    const t = setTimeout(() => setSlow(true), SLOW_REPLY_MS);
    return () => clearTimeout(t);
  }, [pending]);

  if (!q) return null;
  // saved on the server: the question stays, the other answers fade, the timer runs on
  const saved = view.myAnswer;

  const answer = (option: number) => {
    if (pending !== null || saved !== undefined) return;
    setPending(option);
    setSlow(false);
    setMessage(null);
    const payload = { option, questionId: q.id };
    socket.timeout(REPLY_TIMEOUT_MS).emit('quiz:answer', payload, (err, reply) => {
      if (!err && onAck(reply).ok) return; // the server's next view shows "answer saved"
      setPending(null);
      if (err) return setMessage('notSent');
      if (!reply.ok) {
        const known: Partial<Record<string, Key>> = { 'time-up': 'timeUp', paused: 'paused' };
        setMessage(known[reply.error] ?? 'error');
      }
    });
  };

  const duo = q.kind === 'bride-or-groom';
  return (
    <>
      <Countdown view={view} receivedAt={receivedAt} now={now} />
      <PracticeBadge view={view} />
      <p className={`q${isLongText(inLang(q.text, lang)) ? ' long' : ''}`} lang={lang}>
        {inLang(q.text, lang)}
      </p>
      {view.questionNumber === 1 &&
        !view.reading &&
        pending === null &&
        saved === undefined &&
        !message && <p className="caption center-text">{text('tapOnce')}</p>}
      {q.photo && <img className="photo" src={photoUrl(q.photo)} alt="" />}
      {(message || (slow && pending !== null && saved === undefined)) && (
        <p className="notice" role="alert">
          {text(message ?? 'sending')}
        </p>
      )}
      {view.reading && (
        // reading time (Phase 9.5): the answers come for everyone at once when the host shows them
        <div className="grow center reading" role="status">
          <p className="lead">{text('getReady')}</p>
        </div>
      )}
      {!view.reading && (
        <div
          className={`answers grow${duo ? ' duo' : ''}${q.photo ? ' compact' : ''}${saved !== undefined ? ' done' : ''}`}
        >
          {q.options.map((o, i) => (
            <Answer
              key={i}
              kind={q.kind}
              index={i}
              label={inLang(o, lang)}
              className={
                saved === undefined
                  ? pending === i
                    ? 'picked'
                    : ''
                  : saved === i
                    ? 'picked'
                    : 'faded'
              }
              onClick={() => answer(i)}
              disabled={saved !== undefined || !connected || view.paused || pending !== null}
              mark={saved === i}
            />
          ))}
        </div>
      )}
      {saved !== undefined && (
        <div className="saved" role="status">
          <p className="with-icon">
            <Icon name="check" />
            {text('locked')}
          </p>
          {view.myAnswerMs !== undefined && (
            <p className="saved-time">
              {text('answeredIn', { s: formatNumber(lang, view.myAnswerMs / 1000, 1) })}
            </p>
          )}
          <p className="caption">
            {text('answered', { n: view.answeredCount ?? 0, total: view.playerCount })}
          </p>
        </div>
      )}
    </>
  );
}

/** The countdown and the grace for late taps ran out without an answer. */
export function TimeUp({ view, receivedAt, now }: ScreenProps) {
  const text = useText();
  return (
    <>
      <Countdown view={view} receivedAt={receivedAt} now={now} />
      <PracticeBadge view={view} />
      <div className="grow center">
        <h1 className="h-phone">{text('timeUp')}</h1>
        <p className="lead">{text('lookUp')}</p>
      </div>
    </>
  );
}

/** "Your place: 7 of 94" (plain numbers read more easily than 7th / 7. / 7.º). */
function RankCard({ view }: { view: GuestView }) {
  const text = useText();
  // the bride or groom playing along (Phase 9.5): no place, their answers come at the end
  if (view.offBoard) return <p className="lead center-text couple-you">💍 {text('coupleYou')}</p>;
  if (view.rank === undefined) return null;
  const move = rankMove(view.prevRank, view.rank);
  return (
    <div className="surface rank">
      <span className="label">{text('yourPlace')}</span>
      <span className="num place">
        {view.rank} <small>{text('ofN', { n: view.playerCount })}</small>
      </span>
      {move !== undefined && move !== 0 && (
        <span className={`move ${move > 0 ? 'up' : 'down'}`}>
          <Icon name={move > 0 ? 'up' : 'down'} />
          {text('places', { n: Math.abs(move) })}
        </span>
      )}
      <span className="caption total">{text('pointsTotal', { n: view.score ?? 0 })}</span>
    </div>
  );
}

export function Reveal({ view }: ScreenProps) {
  const text = useText();
  const lang = useLang();
  const q = view.question;
  const good = (view.myPoints ?? 0) > 0;
  const correct = view.correctOption;
  // the points count up (short: the phone must never feel slow)
  const animate = useAnimate();
  const points = useCountUp(view.myPoints ?? 0, { from: 0, delay: 250, duration: 900, animate });
  return (
    <div className="grow column-center reveal">
      <PracticeBadge view={view} />
      {good ? (
        <div className="verdict good">
          <span className="badge">
            <Icon name="check" />
          </span>
          <h1 className="h-phone">{text('correct')}</h1>
          <span className="num points">+{formatNumber(lang, points)}</span>
          {view.myAnswerMs !== undefined && (
            <span className="caption">
              {text('answeredIn', { s: formatNumber(lang, view.myAnswerMs / 1000, 1) })}
            </span>
          )}
        </div>
      ) : (
        <div className="verdict bad">
          <span className="badge">
            <Icon name="x" />
          </span>
          <h1 className="h-phone">{text(view.myAnswer === undefined ? 'noAnswer' : 'wrong')}</h1>
          {q && correct !== undefined && (
            <>
              <span className="lead">{text('answerWas')}</span>
              <AnswerChip kind={q.kind} index={correct} label={inLang(q.options[correct]!, lang)} />
            </>
          )}
          {q && view.myAnswer !== undefined && (
            <>
              <span className="lead">{text('youChose')}</span>
              <AnswerChip
                kind={q.kind}
                index={view.myAnswer}
                label={inLang(q.options[view.myAnswer]!, lang)}
              />
            </>
          )}
        </div>
      )}
      <RankCard view={view} />
      {view.rankHidden && !view.offBoard && <p className="lead center-text">{text('podium')}</p>}
    </div>
  );
}

export function Leaderboard({ view }: ScreenProps) {
  const rows = view.around ?? [];
  return (
    <div className="grow column-center">
      <PracticeBadge view={view} />
      {rows.length ? <Around rows={rows} /> : <RankCard view={view} />}
    </div>
  );
}

/** Row height + gap of the phone's ranking (keep in sync with `.around li` in play.css). */
const AROUND_PITCH = 60;

/**
 * Between questions (Phase 6.10): you and up to 3 places above and below, opening in the old
 * order and sliding into the new one with the points counting up, like the big screen's Top 10.
 */
function Around({ rows }: { rows: RankRow[] }) {
  const text = useText();
  const animate = useAnimate();
  const slots = startRows(rows);
  return (
    <div className="around-wrap">
      <span className="eyebrow">{text('yourPlace')}</span>
      <ol className={`around${animate ? ' anim' : ''}`}>
        {rows.map((r, i) => {
          const move = rankMove(r.prevRank, r.rank);
          const from =
            r.prevRank === undefined
              ? (rows.length - i) * AROUND_PITCH
              : (slots[i]! - i) * AROUND_PITCH;
          return (
            <li
              key={i}
              className={`${r.me ? 'me' : ''}${r.prevRank === undefined ? ' fresh' : ''}`}
              style={{ '--from': `${from}px` } as CSSProperties}
            >
              <span className="num pos">{r.rank}</span>
              <span className="who">
                {r.me ? `${r.name.split(' ')[0]} · ${text('you')}` : r.name}
              </span>
              <AroundPoints row={r} animate={animate} />
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
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A row's points, counting up from before the last question (like the big screen). */
function AroundPoints({ row, animate }: { row: RankRow; animate: boolean }) {
  const lang = useLang();
  const n = useCountUp(row.score, {
    from: row.score - (row.gained ?? 0),
    delay: 400,
    duration: 1000, // with the slide: done within 1.5 s (phone rule)
    animate,
  });
  return <span className="num pts">{formatNumber(lang, n)}</span>;
}

/** Joined after the reveal: no points for that question yet. */
export function Wait({ view }: ScreenProps) {
  const text = useText();
  return (
    <div className="grow column-center">
      <PracticeBadge view={view} />
      <p className="lead center-text">{text('waitNext')}</p>
      <RankCard view={view} />
    </div>
  );
}

/**
 * After the podium, when the host shows it (Phase 6.9): everyone's place, your own row marked
 * and scrolled into view (this page may scroll: up to about 100 names).
 */
function FullRanking({ view, rows }: { view: GuestView; rows: RankRow[] }) {
  const text = useText();
  const lang = useLang();
  const mine = useRef<HTMLLIElement>(null);
  useEffect(() => {
    mine.current?.scrollIntoView({ block: 'center' });
  }, []);
  return (
    <div className="grow full-ranking">
      <span className="eyebrow">
        {view.overallRounds ? text('roundsN', { n: view.overallRounds }) : text('finished')}
      </span>
      <h1 className="h-phone">{text(view.overallRounds ? 'overallRanking' : 'fullRanking')}</h1>
      <ol className="ranking">
        {rows.map((r, i) => (
          <li key={i} ref={r.me ? mine : undefined} className={r.me ? 'me' : ''}>
            <span className="num pos">{r.rank}</span>
            <span className="who">
              {r.name}
              {r.me && <small>{text('you')}</small>}
            </span>
            <span className="num">{formatNumber(lang, r.score)}</span>
          </li>
        ))}
      </ol>
      {/* the round's totals; the overall list already shows the points of every round */}
      {view.rank !== undefined && !view.overallRounds && (
        <p className="lead center-text">
          {text('totals', {
            points: view.score ?? 0,
            correct: view.correctCount ?? 0,
            total: view.questionCount,
          })}
        </p>
      )}
    </div>
  );
}

/** The couple's review on a phone (Phase 9.5): the big screen's slide, smaller. */
function CoupleReview({ slide }: { slide: CoupleSlide }) {
  const text = useText();
  const lang = useLang();
  const q = slide.question;
  const same = slide.bride?.option !== undefined && slide.bride.option === slide.groom?.option;
  return (
    <div className="grow couple-review">
      <span className="eyebrow">
        {slide.n !== undefined ? text('nOfTotal', { n: slide.n, total: slide.total }) : '💍'}
      </span>
      <h1 className="h-phone">{text('coupleTitle')}</h1>
      {q ? (
        <>
          <p className="q small" lang={lang}>
            {inLang(q.text, lang)}
          </p>
          <ul className="couple-opts">
            {q.options.map((o, i) => (
              <li key={i} className={`${symbolFor(q.kind, i)}${i === q.correct ? ' right' : ''}`}>
                <Icon name={symbolFor(q.kind, i)} className="sym" />
                <span className="label">{inLang(o, lang)}</span>
                {i === q.correct && <Icon name="check" className="ok" />}
                <span className="picks">
                  {slide.bride?.option === i && (
                    <span className="pick bride">
                      <Icon name="heart" /> {slide.bride.name.split(' ')[0]}
                    </span>
                  )}
                  {slide.groom?.option === i && (
                    <span className="pick groom">
                      <Icon name="star" /> {slide.groom.name.split(' ')[0]}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="lead center-text couple-line">
            {same
              ? text('sameAnswer')
              : [slide.bride, slide.groom]
                  .filter((p) => p && p.option === undefined)
                  .map((p) => `${p!.name.split(' ')[0]}: ${text('coupleNoAnswer')}`)
                  .join(' · ')}
          </p>
        </>
      ) : (
        slide.summary && (
          <div className="couple-sum">
            {(['bride', 'groom'] as const).map((role) => {
              const who = slide.summary![role];
              if (!who) return null;
              return (
                <div key={role} className={`surface couple-card ${role}`}>
                  <Icon name={role === 'bride' ? 'heart' : 'star'} className="sym" />
                  <b>{who.name}</b>
                  <span>{text('rightOf', { n: who.correct, total: slide.total })}</span>
                  {who.wouldRank !== undefined && (
                    <small>{text('placeFun', { n: who.wouldRank })}</small>
                  )}
                </div>
              );
            })}
            {slide.summary.bride && slide.summary.groom && (
              <p className="lead center-text couple-line">
                {text('agreed', { n: slide.summary.agreed, total: slide.total })}
              </p>
            )}
          </div>
        )
      )}
    </div>
  );
}

export function Final({ view }: ScreenProps) {
  const text = useText();
  // after the full ranking: the couple's answers, the same slide as the big screen's (Phase 9.5)
  if (view.couple && !view.warmup) return <CoupleReview slide={view.couple} />;
  if (view.ranking && !view.warmup) return <FullRanking view={view} rows={view.ranking} />;
  if (view.offBoard) {
    return (
      <div className="grow center">
        <span className="eyebrow">{text('finished')}</span>
        <RankCard view={view} />
      </div>
    );
  }
  // the podium is being revealed on the big screen (the warm-up has one too, Phase 6.10): the
  // places come right after it
  if (view.rankHidden) {
    return (
      <div className="grow center">
        <PracticeBadge view={view} />
        <span className="eyebrow">{text(view.warmup ? 'practiceDone' : 'finished')}</span>
        <h1 className="h-phone">{text('podium')}</h1>
      </div>
    );
  }
  if (view.warmup) {
    return (
      <div className="grow center">
        <PracticeBadge view={view} />
        <h1 className="h-phone">{text('practiceDone')}</h1>
        <RankCard view={view} />
      </div>
    );
  }
  return (
    <div className="grow center">
      <span className="eyebrow">{text('finished')}</span>
      <span className="caption">{text('yourPlace')}</span>
      {view.rank !== undefined && <span className="num final-place">{view.rank}</span>}
      <p className="lead">
        {text('ofPlayers', { n: view.playerCount })}
        <br />
        <b>
          {text('totals', {
            points: view.score ?? 0,
            correct: view.correctCount ?? 0,
            total: view.questionCount,
          })}
        </b>
      </p>
    </div>
  );
}
