// The host panel (/host, admin login): run the quiz, fix names, control the big screen.
// Laptop: game on the left, guests / screen / joining on the right. Phone: the same panels in
// tabs, with the big button under the thumb. Helpers use the same login: everything that can't
// be undone asks first.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  foldText,
  JOIN_PATH,
  LANGS,
  missingLangs,
  PODIUM_STEPS,
  UNAUTHORIZED,
  type Ack,
  type HostGuestRow,
  type HostQuestionLists,
  type HostView,
  type Lang,
  type Localized,
  type Side,
  TIMER_MAX_SEC,
  TIMER_MIN_SEC,
} from '@idoknow/shared';
import { LANG_NAMES } from '../i18n';
import { CountryFlag, LangFlag } from '../play/Icon';
import { Editor } from './editor/Editor';
import { Games } from './Games';
import { secondsShown, timeLeft } from '../play/logic';
import { isLocalOnly, joinText } from '../screen/logic';
import { Qr } from '../screen/Qr';
import { socket } from '../socket';
import { useNow } from '../useNow';
import {
  matches,
  type Ask,
  type Choice,
  gameWhen,
  nextAction,
  notConnected,
  parseTimer,
  questionsOf,
  roundLists,
  phaseLine,
  savedLine,
  timerLabel,
  type HostEvent,
} from './logic';
import '../flags.css';
import './host.css';

const REPLY_TIMEOUT_MS = 10_000;

const ERRORS: Record<string, string> = {
  'wrong-phase': 'Not possible right now.',
  'no-warmup': 'There are no warm-up questions in questions.json.',
  'invalid-input': 'Please check what you entered.',
  'duplicate-name': 'This name is already taken (a guest, or another question set).',
  'unknown-guest': 'This guest is not on the list any more.',
  'unknown-band': 'This wristband is not linked.',
  'editing-locked': 'Only in the waiting room (not during the quiz or the warm-up).',
  'not-added': 'Only guests added here can be removed; the others are in guests.json.',
  'unknown-set': 'This question set no longer exists (deleted on another host panel?).',
  'unknown-question': 'This question no longer exists (changed on another host panel?).',
  stale:
    'Not done: the game had moved on (a double tap, or another host was faster). Check the screen and tap again if still needed.',
};

const en = (text: Localized) => text.en;

type Tab = 'game' | 'questions' | 'guests' | 'screen' | 'games';

export default function HostApp() {
  const [view, setView] = useState<HostView | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [guests, setGuests] = useState<HostGuestRow[]>([]);
  const [lists, setLists] = useState<HostQuestionLists>({ questions: [], warmup: [], sets: [] });
  const [connected, setConnected] = useState(socket.connected);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [tab, setTab] = useState<Tab>('game');
  /** A step action is on its way: the big button waits for the reply (no double steps). */
  const [busy, setBusy] = useState(false);
  const now = useNow(true);

  useEffect(() => {
    const onView = (v: HostView) => {
      setView(v);
      setReceivedAt(performance.now());
    };
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onError = (err: Error) => {
      // anything else is a network problem: Socket.IO keeps retrying
      if (err.message === UNAUTHORIZED) window.location.href = '/login';
    };
    socket.on('state:host', onView);
    socket.on('state:guests', setGuests);
    socket.on('state:questions', setLists);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.connect(); // after the listeners, so the first state isn't missed
    return () => {
      socket.off('state:host', onView);
      socket.off('state:guests', setGuests);
      socket.off('state:questions', setLists);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
    };
  }, []);

  // a notice disappears by itself after a while
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Shows the outcome of any action: errors stay readable, successes are quiet. */
  const report = (done?: string) => (err: Error | null, reply?: Ack) => {
    if (err)
      return setNotice({ text: 'No reply from the server. Check the connection.', bad: true });
    if (reply && !reply.ok) {
      return setNotice({ text: ERRORS[reply.error] ?? `Refused: ${reply.error}`, bad: true });
    }
    if (done) setNotice({ text: done, bad: false });
  };

  if (!view) {
    return (
      <main className="host">
        <p className="h-muted">{connected ? 'Loading…' : 'Connecting…'}</p>
      </main>
    );
  }

  /**
   * Step actions carry the step this panel shows: the server refuses them once the game has
   * moved on, so a double tap, a second host or a sheet left open can never skip a step.
   */
  const at = { step: view.step, pause: view.pauseStep };
  const send = (event: HostEvent, done?: string) => {
    if (busy) return;
    setBusy(true);
    const key = event === 'host:pause' || event === 'host:resume' ? at.pause : at.step;
    socket.timeout(REPLY_TIMEOUT_MS).emit(event, { at: key }, (err, reply) => {
      setBusy(false);
      report(done)(err, reply);
    });
  };
  /** +10 seconds: also waits for its reply, so a double tap adds 10 s, not 20 s. */
  const addTime = () => {
    if (busy) return;
    setBusy(true);
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:addTime', { ms: 10_000 }, (err, reply) => {
      setBusy(false);
      report('+10 seconds.')(err, reply);
    });
  };

  const props: PanelProps = { view, send, report, setAsk, addTime, busy };
  return (
    <main className="host">
      <header className="h-top">
        <img className="h-logo" src="/brand/wordmark-light.webp" alt="I Do! (know)" />
        <span className="h-title">Host</span>
        <span className={`h-live${connected ? '' : ' off'}`} />
        <span className="h-muted">
          {connected
            ? (savedLine(view.savedAgoMs, now - receivedAt) ?? 'connected')
            : 'Reconnecting…'}
        </span>
        <form method="post" action="/logout" className="h-logout">
          <button className="h-btn small">Log out</button>
        </form>
      </header>

      {view.saveFailing && (
        <p className="h-warning" role="alert">
          Saving the game failed. Check the server (disk space?). The game goes on, but a restart
          now would lose the latest changes.
        </p>
      )}
      {view.past && (
        // the room sees an old game: never forget to switch back
        <p className="h-info" role="status">
          The big screen shows a past game ({gameWhen(view.past.finishedAt)}).
          <button
            className="h-btn small"
            onClick={() =>
              socket
                .timeout(REPLY_TIMEOUT_MS)
                .emit(
                  'host:showPast',
                  { id: null },
                  report('The big screen shows the live game again.'),
                )
            }
          >
            Back to the live game
          </button>
        </p>
      )}
      {/* only real problems up here; setup notes are in the Screen & joining tab */}
      {view.warnings.map((w) => (
        <p key={w} className="h-warning">
          {w}
        </p>
      ))}

      <nav className="h-tabs" aria-label="Sections">
        {(['game', 'questions', 'guests', 'screen', 'games'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {
              {
                game: 'Game',
                questions: 'Questions',
                guests: 'Guests',
                screen: 'Joining',
                games: 'Past',
              }[t]
            }
          </button>
        ))}
      </nav>

      <div className="h-grid">
        <div className="h-col">
          <GamePanel
            {...props}
            hidden={tab !== 'game'}
            receivedAt={receivedAt}
            now={now}
            online={connected}
            untranslated={{
              // the round being played (the main quiz or a set) and the warm-up
              round: questionsOf(lists, view.activeSet).filter((q) => missingLangs(q).length)
                .length,
              warmup: lists.warmup.filter((q) => missingLangs(q).length).length,
            }}
            lists={lists}
          />
          {view.top && <TopPanel view={view} hidden={tab !== 'game'} />}
          {view.phase === 'lobby' && !view.warmup ? (
            // the waiting room: the question editor
            <Editor
              view={view}
              lists={lists}
              report={report}
              setAsk={setAsk}
              frame={(title, children) => (
                <Panel title={title} hidden={tab !== 'questions'}>
                  {children}
                </Panel>
              )}
            />
          ) : (
            <QuestionsPanel view={view} lists={lists} hidden={tab !== 'questions'} />
          )}
        </div>
        <div className="h-col">
          <JoinPanel {...props} hidden={tab !== 'screen'} />
          <GuestsPanel {...props} guests={guests} hidden={tab !== 'guests'} />
          <ScreenPanel {...props} hidden={tab !== 'screen'} />
          <Games
            view={view}
            report={report}
            setAsk={setAsk}
            frame={(title, children) => (
              <Panel title={title} hidden={tab !== 'games'}>
                {children}
              </Panel>
            )}
          />
        </div>
      </div>

      {notice && (
        <p className={`h-notice${notice.bad ? ' bad' : ''}`} role="status">
          {notice.text}
        </p>
      )}
      {ask && <AskSheet ask={ask} onClose={() => setAsk(null)} />}
    </main>
  );
}

interface PanelProps {
  view: HostView;
  /** A game action is waiting for its reply: the game buttons wait too. */
  busy: boolean;
  addTime: () => void;
  send: (event: HostEvent, done?: string) => void;
  report: (done?: string) => (err: Error | null, reply?: Ack) => void;
  setAsk: (ask: Ask | null) => void;
}

/** A panel: always shown on a laptop, only in its tab on a phone. */
function Panel({
  title,
  hidden,
  children,
}: {
  title: string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`h-panel${hidden ? ' narrow-hidden' : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function GamePanel({
  view,
  send,
  report,
  setAsk,
  addTime,
  busy,
  hidden,
  receivedAt,
  now,
  online,
  untranslated,
  lists,
}: PanelProps & {
  hidden: boolean;
  receivedAt: number;
  now: number;
  online: boolean;
  /** Questions per list that still miss a language (they block the start). */
  untranslated: { round: number; warmup: number };
  lists: HostQuestionLists;
}) {
  const action = nextAction(view, untranslated.round);
  // pause and +10 s belong to the countdown: not during the reading time (Phase 9.5)
  const running = view.phase === 'question' && !view.reading;
  const seconds = secondsShown(timeLeft(view, receivedAt, now));
  const confirmThen = (title: string, body: string, choice: Choice) =>
    setAsk({ title, body, choices: [choice] });

  const onNext = () => {
    const event = action.event;
    if (!event || busy) return;
    if (action.confirm) {
      const c = action.confirm;
      confirmThen(c.title, c.body, { label: c.yes, tone: c.tone, run: () => send(event) });
    } else send(event);
  };

  return (
    <Panel title="Game" hidden={hidden}>
      <p className="h-state">
        <span className={`h-live${view.paused ? ' paused' : ''}`} />
        {phaseLine(view, seconds)}
        {view.warmup && <span className="h-badge">practice</span>}
      </p>
      <RoundControls view={view} lists={lists} report={report} setAsk={setAsk} />
      {view.coupleRound && !view.warmup && (
        // Phase 9.5: they answer, but stand in no ranking; their review comes after the full one
        <p className="h-muted">
          💍 {[view.coupleMarked.bride, view.coupleMarked.groom].filter(Boolean).join(' & ')} play
          along in this round: off the leaderboard, their answers are shown at the end.
        </p>
      )}
      <div className="h-kpis">
        <Kpi n={view.connectedGuests} label="connected" />
        <Kpi
          n={view.answeredCount}
          label={`answered of ${view.playerCount}`}
          dim={!(running || view.phase === 'reveal')}
        />
        <Kpi n={notConnected(view)} label="not connected" warn={notConnected(view) > 0} />
        <Kpi n={view.guestCount} label="on guest list" />
      </div>

      {/* while a reply is on its way it only looks off (aria-disabled keeps the keyboard focus) */}
      <button
        className={`h-next${busy ? ' busy' : ''}`}
        onClick={onNext}
        disabled={!action.event || !online}
        aria-disabled={busy}
      >
        <b>{action.label}</b>
        {action.then && <span>{action.then}</span>}
      </button>

      <div className="h-ctrls">
        {running &&
          (view.paused ? (
            <button className="h-btn" aria-disabled={busy} onClick={() => send('host:resume')}>
              Resume
            </button>
          ) : (
            <button className="h-btn" aria-disabled={busy} onClick={() => send('host:pause')}>
              Pause
            </button>
          ))}
        {running && (
          <button className="h-btn" aria-disabled={busy} onClick={addTime}>
            +10 seconds
          </button>
        )}
        {view.phase === 'question' && (
          <button
            className="h-btn caution"
            onClick={() =>
              confirmThen(
                `Skip question ${view.questionNumber}?`,
                "Nobody gets points for it. You can't undo this.",
                { label: 'Skip question', tone: 'danger', run: () => send('host:skip') },
              )
            }
          >
            Skip question
          </button>
        )}
        {view.phase === 'lobby' && !view.warmup && view.warmupAvailable && (
          <button
            className="h-btn"
            onClick={() => send('host:startWarmup')}
            disabled={untranslated.warmup > 0}
            title={untranslated.warmup ? 'Complete the warm-up translations first' : undefined}
          >
            Start warm-up
          </button>
        )}
        {view.warmup && view.phase !== 'final' && (
          <button
            className="h-btn caution"
            onClick={() =>
              confirmThen(
                'End the warm-up now?',
                "Everyone goes back to the waiting room. Practice points don't count anyway.",
                { label: 'End the warm-up', tone: 'caution', run: () => send('host:endWarmup') },
              )
            }
          >
            End warm-up
          </button>
        )}
        {!view.warmup && view.phase !== 'lobby' && (
          <button
            className="h-btn danger"
            onClick={() =>
              confirmThen(
                view.phase === 'final' ? 'Back to the waiting room?' : 'Restart the whole quiz?',
                view.phase === 'final'
                  ? "For the next round: this round's scores go back to 0 (it stays in Past games and in the overall ranking). Guests stay joined."
                  : "All scores go back to 0 and the quiz returns to the waiting room. Guests stay joined. You can't undo this.",
                { label: 'Restart the quiz', tone: 'danger', run: () => send('host:restart') },
              )
            }
          >
            Restart quiz
          </button>
        )}
      </div>
      {view.phase === 'lobby' && !view.warmup ? (
        // a new field when the timer changes (e.g. set by another host): it shows the new value
        <TimerSetting key={view.timeLimitSec} view={view} report={report} />
      ) : (
        <p className="h-muted">Timer: {timerLabel(view.timeLimitSec)} per question.</p>
      )}
      <label className="h-switch">
        <input
          type="checkbox"
          checked={view.readingStep}
          onChange={(e) =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit(
                'host:setReadingStep',
                { on: e.target.checked },
                report(e.target.checked ? 'Reading time on.' : 'Reading time off.'),
              )
          }
        />
        <span>
          <b>Reading time</b>
          <small>
            Each question comes alone first; you tap "Show the answers" when the room has read it,
            then the countdown starts. Fair for slower readers. Takes effect from the next question.
          </small>
        </span>
      </label>
      <label className="h-switch">
        <input
          type="checkbox"
          checked={view.autoReveal}
          onChange={(e) =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit(
                'host:setAutoReveal',
                { on: e.target.checked },
                report(e.target.checked ? 'Auto-reveal on.' : 'Auto-reveal off.'),
              )
          }
        />
        <span>
          <b>Auto-reveal</b>
          <small>
            The answer shows by itself when the time is up, or when everyone still playing has
            answered. Off: you tap Reveal.
          </small>
        </span>
      </label>
    </Panel>
  );
}

/**
 * Rounds (Phase 6.10): which question set the next round plays (picked in the waiting room),
 * and the overall ranking over every round played to the end.
 */
function RoundControls({
  view,
  lists,
  report,
  setAsk,
}: Pick<PanelProps, 'view' | 'report' | 'setAsk'> & { lists: HostQuestionLists }) {
  const rounds = roundLists(lists);
  const current = rounds.find((l) => l.id === view.activeSet);
  const canPick = view.phase === 'lobby' && !view.warmup;
  // not before the whole podium is revealed (places are the podium's news)
  const overallAllowed =
    !view.warmup &&
    view.roundsPlayed > 0 &&
    (view.phase === 'lobby' || (view.phase === 'final' && view.podiumShown >= PODIUM_STEPS));
  const emit = (event: 'host:showOverall', on: boolean, done: string) =>
    socket.timeout(REPLY_TIMEOUT_MS).emit(event, { on }, report(done));
  return (
    <div className="h-rounds">
      {canPick && rounds.length > 1 ? (
        <label className="h-round-pick">
          <span>Round</span>
          <select
            className="h-input"
            value={view.activeSet}
            onChange={(e) =>
              socket
                .timeout(REPLY_TIMEOUT_MS)
                .emit(
                  'host:selectSet',
                  { id: e.target.value },
                  report('The next round plays this set.'),
                )
            }
          >
            {rounds.map((l) => (
              <option key={l.id} value={l.id}>
                {view.playedSets.includes(l.id) ? '✓ ' : ''}
                {l.name} ({l.questions.length})
              </option>
            ))}
          </select>
        </label>
      ) : (
        rounds.length > 1 && (
          <p className="h-muted">
            Round: <b>{current?.name ?? 'Main quiz'}</b>
          </p>
        )
      )}
      {overallAllowed && (
        <div className="h-ctrls">
          <button
            className="h-btn"
            onClick={() =>
              view.overallShown
                ? emit('host:showOverall', false, 'Overall ranking hidden.')
                : emit('host:showOverall', true, 'Overall ranking on the big screen and phones.')
            }
          >
            {view.overallShown
              ? 'Hide the overall ranking'
              : `Show the overall ranking (${view.roundsPlayed} ${view.roundsPlayed === 1 ? 'round' : 'rounds'})`}
          </button>
          <button
            className="h-btn caution"
            onClick={() =>
              setAsk({
                title: 'Start the overall ranking again?',
                body: `Forgets the ${view.roundsPlayed} round(s) played so far (e.g. test rounds). The saved games in Past games stay.`,
                choices: [
                  {
                    label: 'Reset the overall ranking',
                    tone: 'danger',
                    run: () =>
                      socket
                        .timeout(REPLY_TIMEOUT_MS)
                        .emit('host:resetOverall', report('Overall ranking reset.')),
                  },
                ],
              })
            }
          >
            Reset overall…
          </button>
        </div>
      )}
    </div>
  );
}

/** One countdown for every question (warm-up included): only in the waiting room. */
function TimerSetting({ view, report }: Pick<PanelProps, 'view' | 'report'>) {
  const [input, setInput] = useState(String(view.timeLimitSec));
  const [saving, setSaving] = useState(false);
  const sec = parseTimer(input);
  const save = () => {
    if (sec === null || saving) return;
    setSaving(true);
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:setTimer', { sec }, (err, reply) => {
      setSaving(false);
      report(`Timer set: ${timerLabel(sec)} per question.`)(err, reply);
    });
  };
  return (
    <form
      className="h-timer"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor="h-timer">
        Timer per question <small>(now {timerLabel(view.timeLimitSec)})</small>
      </label>
      <input
        id="h-timer"
        className="h-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        inputMode="numeric"
        aria-invalid={sec === null}
        aria-describedby="h-timer-hint"
      />
      <button
        className="h-btn"
        disabled={sec === null || sec === view.timeLimitSec}
        aria-disabled={saving}
      >
        Set
      </button>
      <small id="h-timer-hint" className={sec === null ? 'bad' : ''}>
        {TIMER_MIN_SEC} to {TIMER_MAX_SEC} seconds (or m:ss, e.g. 1:30). Points go from 1000 (at
        once) to 500 (at the last second).
      </small>
    </form>
  );
}

/** The Top 10 as the big screen has it; in the final, which podium places are out. */
function TopPanel({ view, hidden }: { view: HostView; hidden: boolean }) {
  const onScreen = (rank: number, score: number) =>
    view.phase === 'final' &&
    score > 0 &&
    rank <= PODIUM_STEPS &&
    rank > PODIUM_STEPS - view.podiumShown;
  return (
    <Panel title={view.phase === 'final' ? 'Podium' : 'Top 10'} hidden={hidden}>
      <ol className="h-top10">
        {(view.top ?? []).map((r, i) => (
          <li key={i} className={onScreen(r.rank, r.score) ? 'out' : ''}>
            <span className="n">{r.rank}</span>
            {r.country ? <CountryFlag code={r.country} /> : <span />}
            <span className="who">{r.name}</span>
            <span className="pts">{r.score}</span>
            {onScreen(r.rank, r.score) ? <small>on screen</small> : <span />}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function Kpi({ n, label, warn, dim }: { n: number; label: string; warn?: boolean; dim?: boolean }) {
  return (
    <div className={`h-kpi${warn ? ' warn' : ''}${dim ? ' dim' : ''}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}

function QuestionsPanel({
  view,
  lists,
  hidden,
}: {
  view: HostView;
  lists: HostQuestionLists;
  hidden: boolean;
}) {
  const list = view.warmup ? lists.warmup : questionsOf(lists, view.activeSet);
  const current = view.phase === 'lobby' ? -1 : view.questionNumber - 1;
  return (
    <Panel title={view.warmup ? 'Warm-up questions' : 'Questions'} hidden={hidden}>
      <ol className="h-qlist">
        {list.map((q, i) => (
          <li
            key={q.id}
            className={i === current ? 'now' : i < current || view.phase === 'final' ? 'done' : ''}
          >
            <span className="n">{i + 1}</span>
            <span className="t">
              {en(q.text)}
              <small>
                {q.kind === 'photo'
                  ? 'photo · '
                  : q.kind === 'bride-or-groom'
                    ? 'bride or groom · '
                    : ''}
                answer: <b>{en(q.options[q.correct]!)}</b>
              </small>
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function GuestsPanel({
  view,
  report,
  setAsk,
  guests,
  hidden,
}: PanelProps & { guests: HostGuestRow[]; hidden: boolean }) {
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [country, setCountry] = useState('PL');
  const [side, setSide] = useState<Side>('bride');
  const fold = (s: string) => foldText(s, false);
  const shown = useMemo(
    () => guests.filter((g) => matches(g.name, query, (s) => foldText(s, false))),
    [guests, query],
  );

  // the public demo: players who join and answer by themselves
  const addBots = () =>
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:addBots', report('Demo players added.'));

  const add = (allowDuplicate = false) =>
    socket
      .timeout(REPLY_TIMEOUT_MS)
      .emit('host:addGuest', { name, country, side, allowDuplicate }, (err, reply) => {
        if (!err && !reply.ok && reply.error === 'duplicate-name') {
          return setAsk({
            title: `"${name}" is already on the list`,
            body: 'Is this really a different person with the same name?',
            choices: [{ label: 'Add a second guest', run: () => add(true) }],
          });
        }
        report(`${name} added.`)(err, reply);
        if (!err && reply.ok) setName('');
      });

  const release = (g: HostGuestRow) =>
    setAsk({
      title: `Release "${g.name}"?`,
      body: `That phone goes back to the name search${view.joiningOpen ? '' : ' (it can pick a name again once you open joining)'}. The points stay with the name.`,
      choices: [
        {
          label: 'Release name',
          tone: 'caution',
          run: () =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit('host:releaseGuest', { guestId: g.id }, report(`${g.name} released.`)),
        },
      ],
    });

  // guests the host added (by mistake, or twice): gone with their score, at any time
  const remove = (g: HostGuestRow) =>
    setAsk({
      title: `Remove "${g.name}" from the guest list?`,
      body: `${g.claimed ? 'Their phone goes back to the name search. ' : ''}${view.phase === 'lobby' ? '' : 'Their points leave the ranking now. '}You can add them again later, but not their points.`,
      choices: [
        {
          label: 'Remove guest',
          tone: 'danger',
          run: () =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit('host:removeGuest', { guestId: g.id }, report(`${g.name} removed.`)),
        },
      ],
    });

  const unlink = (g: HostGuestRow) =>
    setAsk({
      title: `Unlink the wristband of "${g.name}"?`,
      body: 'Collected points stay.',
      choices: [
        {
          label: 'Unlink wristband',
          tone: 'caution',
          run: () =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit('host:unlinkBand', { code: g.band! }, report('Wristband unlinked.')),
        },
      ],
    });

  return (
    <Panel title={`Guests · ${view.joinedGuests} of ${view.guestCount} joined`} hidden={hidden}>
      <input
        className="h-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a name"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      <ul className="h-glist">
        {shown.map((g) => (
          <li key={g.id}>
            <span className={`dot ${g.claimed ? (g.online ? 'on' : 'off') : ''}`} />
            <CountryFlag code={g.country} />
            <span className="who">
              {g.name}
              <small>
                {g.claimed ? (g.online ? 'online' : 'joined, not connected') : 'not joined'}
                {g.band ? ` · band ${g.band}` : ''}
                {g.added ? ' · added' : ''}
                {g.role ? ` · 💍 ${g.role}` : ''}
              </small>
            </span>
            <span className="acts">
              {g.claimed && (
                <button className="h-btn small caution" onClick={() => release(g)}>
                  Release
                </button>
              )}
              {g.added && (
                <button className="h-btn small danger" onClick={() => remove(g)}>
                  Remove
                </button>
              )}
              {g.band && (
                <button className="h-btn small" onClick={() => unlink(g)}>
                  Unlink band
                </button>
              )}
            </span>
          </li>
        ))}
        {shown.length === 0 && <li className="h-muted">No guest matches “{query}”.</li>}
      </ul>
      {view.demo && (
        <div className="h-demo">
          <p className="h-muted">
            Public demo: add 8 players who join and answer by themselves (from the next question
            on). Join with your phone too.
          </p>
          <button className="h-btn" onClick={addBots}>
            Add 8 demo players
          </button>
        </div>
      )}
      <details className="h-add">
        <summary>Add a missing guest</summary>
        <div className="h-form">
          <input
            className="h-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Full name"
          />
          <select className="h-input" value={country} onChange={(e) => setCountry(e.target.value)}>
            {['PL', 'ES', 'DE', 'GB', 'FR', 'IT', 'NL', 'US'].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select
            className="h-input"
            value={side}
            onChange={(e) => setSide(e.target.value as Side)}
          >
            <option value="bride">Bride's side ({view.sides.bride})</option>
            <option value="groom">Groom's side ({view.sides.groom})</option>
          </select>
          <button className="h-btn" disabled={fold(name).trim().length < 2} onClick={() => add()}>
            Add guest
          </button>
        </div>
      </details>
    </Panel>
  );
}

function ScreenPanel({ view, report, hidden }: PanelProps & { hidden: boolean }) {
  const setLang = (lang: Lang) =>
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:setScreenLang', { lang }, report());
  return (
    <Panel title="Big screen" hidden={hidden}>
      <div className="h-seg" role="group" aria-label="Big screen language">
        {LANGS.map((l) => (
          <button
            key={l}
            className={view.lang === l ? 'on' : ''}
            onClick={() => setLang(l)}
            title={LANG_NAMES[l]}
          >
            <LangFlag lang={l} />
            {l.toUpperCase()}
          </button>
        ))}
      </div>
      <p className="h-muted">
        Phones always show each guest&apos;s own language.{' '}
        <a href="/screen" target="_blank" rel="noreferrer">
          Open the big screen
        </a>{' '}
        (on the projector laptop, press F for full screen).
      </p>
      {view.notes.length > 0 && (
        <details className="h-setup">
          <summary>Setup notes ({view.notes.length})</summary>
          <ul>
            {view.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

/** The fixed join link, the switch that opens and closes joining, and the emergency release. */
function JoinPanel({ view, report, setAsk, hidden }: PanelProps & { hidden: boolean }) {
  const [busy, setBusy] = useState(false);
  const url = window.location.origin + JOIN_PATH;
  const setJoining = (open: boolean) => {
    if (busy) return;
    setBusy(true);
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:setJoining', { open }, (err, reply) => {
      setBusy(false);
      report(open ? 'Joining is open.' : 'Joining is closed.')(err, reply);
    });
  };
  const releaseRecent = (minutes: number) =>
    socket
      .timeout(REPLY_TIMEOUT_MS)
      .emit('host:releaseRecent', { minutes }, (err, reply) =>
        report(reply?.ok ? `${reply.released} recent names released.` : undefined)(err, reply),
      );
  return (
    <Panel title="Joining" hidden={hidden}>
      <div className={`h-joining${view.joiningOpen ? ' open' : ''}`}>
        <p>
          <b>{view.joiningOpen ? 'Joining is open' : 'Joining is closed'}</b>
          <br />
          {view.joiningOpen
            ? 'New guests can pick their name.'
            : 'Phones that open the link see "You\'re a bit early" and go on by themselves once you open it. Guests who already joined stay in.'}
        </p>
        <button
          className={`h-btn big${view.joiningOpen ? ' caution' : ''}`}
          aria-disabled={busy}
          onClick={() => setJoining(!view.joiningOpen)}
        >
          {view.joiningOpen ? 'Close joining' : 'Open joining'}
        </button>
      </div>
      <div className="h-join">
        <div className="h-qr">
          <Qr text={url} px={132} />
        </div>
        <p className="h-muted">
          The same link all evening (QR code, stickers, typed):
          <br />
          <span className="h-url">{joinText(window.location.host)}</span>
        </p>
      </div>
      {isLocalOnly(window.location.hostname) && (
        <p className="h-warning">
          This panel is open at {window.location.host}: phones can&apos;t use that address. Open the
          panel and the big screen at the computer&apos;s network address (e.g.
          http://192.168.1.23:3210) or the real domain.
        </p>
      )}
      <button
        className="h-btn danger"
        onClick={() =>
          setAsk({
            title: 'Release the names picked recently?',
            body: `Only for emergencies (strangers took names). Close joining first if they may try again. Those phones go back to the name search; real guests among them pick their name again once joining is open${view.joiningOpen ? '' : ' (it is closed now)'}. Their points stay with their name.`,
            choices: [
              {
                label: 'Release names picked in the last 15 min',
                tone: 'danger',
                run: () => releaseRecent(15),
              },
              {
                label: 'Release names picked in the last 60 min',
                tone: 'danger',
                run: () => releaseRecent(60),
              },
            ],
          })
        }
      >
        Release recent names…
      </button>
      {view.event && (
        <button
          className="h-btn caution"
          onClick={() =>
            setAsk({
              title: 'End the event?',
              body: 'The app restarts as the public demo: every phone, the big screen and this panel are disconnected. The event’s games, guests and questions stay saved on the server; the event password starts it again.',
              choices: [
                {
                  label: 'End the event',
                  tone: 'caution',
                  run: () =>
                    socket
                      .timeout(REPLY_TIMEOUT_MS)
                      .emit(
                        'host:endEvent',
                        report('Ending the event: the demo starts in a moment.'),
                      ),
                },
              ],
            })
          }
        >
          End the event (back to the demo)…
        </button>
      )}
    </Panel>
  );
}

function AskSheet({ ask, onClose }: { ask: Ask; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  // the panel re-renders often (the clock): keep the latest onClose without re-running the effect
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  // where the focus was when the sheet opened (read while rendering: before Cancel's autofocus)
  const [before] = useState(() => document.activeElement as HTMLElement | null);
  // keyboard: Escape closes, Tab stays inside the sheet, and focus goes back where it was
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close.current();
      if (e.key !== 'Tab' || !card.current) return;
      const buttons = [...card.current.querySelectorAll('button')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    const node = card.current;
    return () => {
      window.removeEventListener('keydown', onKey);
      // only when the sheet is really gone (React's dev mode also runs this once as a test)
      if (node?.isConnected) return;
      // the button that opened it may be gone too (e.g. "Release" of a released name)
      const back = before?.isConnected ? before : document.querySelector<HTMLElement>('.h-next');
      back?.focus();
    };
  }, [before]);
  return (
    <div
      className="h-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={ask.title}
      onClick={onClose}
    >
      <div className="h-card" ref={card} onClick={(e) => e.stopPropagation()}>
        <h3>{ask.title}</h3>
        <p>{ask.body}</p>
        {ask.choices.map((c) => (
          <button
            key={c.label}
            className={`h-btn big ${c.tone ?? ''}`}
            onClick={() => {
              onClose();
              c.run();
            }}
          >
            {c.label}
          </button>
        ))}
        <button className="h-btn big quiet" onClick={onClose} autoFocus>
          Cancel
        </button>
      </div>
    </div>
  );
}
