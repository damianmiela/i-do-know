// The guest's phone (/play). One job per screen; which screen comes from screenFor() (logic.ts).
import { useCallback, useEffect, useState } from 'react';
import { JOIN_PATH, UNAUTHORIZED, type Ack, type GuestView, type Lang } from '@idoknow/shared';
import { detectLang } from '../i18n';
import { useNow } from '../useNow';
import { socket } from '../socket';
import { LangContext, useLang, useText } from './context';
import { Icon, LangFlag } from './Icon';
import { LanguageStep, NameSearch } from './Join';
import { fitsScreen, isTimeUp, screenFor, shortName, type Screen } from './logic';
import { Final, Leaderboard, Lobby, QuestionScreen, Reveal, TimeUp, Wait } from './Quiz';
import { KEYS, load, save } from './storage';
import '../flags.css';
import './play.css';

function initialLang(): Lang {
  const saved = load(KEYS.lang);
  return saved && ['pl', 'es', 'ca', 'de', 'en'].includes(saved)
    ? (saved as Lang)
    : detectLang(navigator.languages ?? [navigator.language]);
}

interface WakeLock {
  release: () => Promise<void>;
}

/**
 * During the quiz: keep the screen on (many phones lock after 30 s, and unlocking costs half a
 * question), and after the phone was locked or in the background for a while, reconnect at once
 * instead of waiting for a stale connection to time out.
 */
function useAwake(quizRunning: boolean) {
  useEffect(() => {
    let lock: WakeLock | null = null;
    const api = (navigator as { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } })
      .wakeLock;
    const request = () => {
      if (!quizRunning || !api || document.visibilityState !== 'visible') return;
      api.request('screen').then(
        (l) => (lock = l),
        () => {}, // not allowed or not supported: the phone just locks as usual
      );
    };
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      request(); // the browser drops the wake lock whenever the page is hidden
      if (hiddenAt && Date.now() - hiddenAt > 10_000) {
        socket.disconnect().connect(); // a fresh connection brings the current state at once
      }
      hiddenAt = 0;
    };
    request();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      lock?.release().catch(() => {});
    };
  }, [quizRunning]);
}

export default function PlayApp() {
  const [view, setView] = useState<GuestView | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [connected, setConnected] = useState(socket.connected);
  const [refused, setRefused] = useState(false);
  const [lang, setLang] = useState<Lang>(initialLang);
  const [langChosen, setLangChosen] = useState(() => load(KEYS.langChosen) === '1');
  const [pickingLang, setPickingLang] = useState(false);

  useEffect(() => {
    const onView = (v: GuestView) => {
      setView(v);
      setReceivedAt(performance.now());
    };
    // "62 of 94 have answered": only the counts change, the countdown keeps running
    const onAnswered = (c: { answeredCount: number; playerCount: number }) =>
      setView((v) => (v?.phase === 'question' ? { ...v, ...c } : v));
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    let retry: ReturnType<typeof setTimeout> | undefined;
    const onError = (err: Error) => {
      if (err.message === UNAUTHORIZED) return setRefused(true);
      // refused by the server for another reason (too many connections): Socket.IO doesn't
      // retry those by itself, so try again a little later; network errors retry on their own
      if (!socket.active) {
        clearTimeout(retry);
        retry = setTimeout(() => socket.connect(), 5_000);
      }
    };
    socket.on('state:guest', onView);
    socket.on('state:answered', onAnswered);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.connect(); // after the listeners, so the first state isn't missed
    return () => {
      socket.off('state:guest', onView);
      socket.off('state:answered', onAnswered);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
      clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // "/play?j" (straight from the join link): a clean address to bookmark or share
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  // stable, because the name search effect depends on it (a place for reactions to any reply;
  // `joining-closed` needs none: the server's next view shows "too early")
  const onAck = useCallback((result: Ack): Ack => result, []);

  const quizRunning = !!view?.joined && view.phase !== 'lobby' && view.phase !== 'final';
  useAwake(quizRunning);
  // the countdown runs on after answering too (the guest sees how long the others still have)
  const counting = view?.phase === 'question' && !view.paused;
  const now = useNow(counting);
  const timeUp = !!view && isTimeUp(view, receivedAt, now);

  const chooseLang = (l: Lang) => {
    setLang(l);
    save(KEYS.lang, l);
  };
  const confirmLang = () => {
    setLangChosen(true);
    save(KEYS.langChosen, '1');
    setPickingLang(false);
  };

  const screen = pickingLang ? 'language' : screenFor(view, { refused, langChosen, timeUp });
  const props = view && { view, receivedAt, now, connected, onAck };

  return (
    <LangContext.Provider value={lang}>
      {/* a question is one screen, never more: nothing to scroll while the clock runs */}
      <main className={`app phone${fitsScreen(screen) ? ' fit' : ''}`}>
        {view && !connected && !refused && <Offline />}
        <TopBar view={view} screen={screen} onLanguage={() => setPickingLang(true)} />
        {screen === 'scan-again' && <ScanAgain />}
        {screen === 'connecting' && <Connecting />}
        {screen === 'too-early' && <TooEarly lobby={view?.phase === 'lobby'} />}
        {screen === 'language' && (
          <LanguageStep
            name={view?.joined ? view.name : undefined}
            lang={lang}
            onPick={chooseLang}
            onDone={confirmLang}
          />
        )}
        {screen === 'search' && <NameSearch onAck={onAck} />}
        {props && screen === 'lobby' && <Lobby {...props} />}
        {props && screen === 'question' && (
          // a new component per question (and round): nothing lingers from the previous one
          <QuestionScreen key={`${view.warmup ? 'w' : 'q'}-${view.question?.id}`} {...props} />
        )}
        {props && screen === 'time-up' && <TimeUp {...props} />}
        {props && screen === 'reveal' && <Reveal {...props} />}
        {props && screen === 'wait' && <Wait {...props} />}
        {props && screen === 'leaderboard' && <Leaderboard {...props} />}
        {props && screen === 'final' && <Final {...props} />}
      </main>
    </LangContext.Provider>
  );
}

function TopBar({
  view,
  screen,
  onLanguage,
}: {
  view: GuestView | null;
  screen: Screen;
  onLanguage: () => void;
}) {
  const text = useText();
  const lang = useLang();
  // during a question the countdown bar shows the question number, so only after it here
  const inQuiz = view && (screen === 'reveal' || screen === 'wait' || screen === 'leaderboard');
  return (
    <div className="bar">
      {/* short and plain, so the three always fit one line (Damian's second test) */}
      {inQuiz ? (
        <span className="bar-count">
          {text('nOfTotal', { n: view.questionNumber, total: view.questionCount })}
        </span>
      ) : (
        <img className="logo" src="/brand/wordmark-light.webp" alt="I Do! (know)" />
      )}
      <span className="bar-end">
        {view?.joined && view.name && <span className="bar-name">{shortName(view.name)}</span>}
        {screen !== 'language' && (
          <button className="lang-button" onClick={onLanguage} aria-label={text('language')}>
            <LangFlag lang={lang} />
          </button>
        )}
      </span>
    </div>
  );
}

function Offline() {
  const text = useText();
  return (
    <div className="offline" role="status">
      <Icon name="signal" />
      {text('reconnecting')}
    </div>
  );
}

/** Nothing to show yet: after a second, say so (on roaming the first state can take a while). */
function Connecting() {
  const text = useText();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 1_000);
    return () => clearTimeout(t);
  }, []);
  return <div className="grow center">{show && <p className="lead">{text('connecting')}</p>}</div>;
}

function ScanAgain() {
  const text = useText();
  return (
    <div className="grow center">
      <img className="logo-big" src="/brand/logo-light.webp" alt="I Do! (know)" />
      <h1 className="h-phone">{text('scanAgainTitle')}</h1>
      <p className="lead">{text('scanAgainLead')}</p>
      {/* the join link gives the phone a new session (a plain link: works without the socket) */}
      <a className="btn" href={JOIN_PATH}>
        {text('rejoin')}
      </a>
    </div>
  );
}

/**
 * Joining isn't open: the phone waits here and goes on by itself when the host opens it. Before
 * the quiz that's "too early"; once it runs (a late guest), joining is simply closed.
 */
function TooEarly({ lobby }: { lobby: boolean }) {
  const text = useText();
  return (
    <div className="grow center">
      <img className="logo-big" src="/brand/logo-light.webp" alt="I Do! (know)" />
      <h1 className="h-phone">{text(lobby ? 'tooEarlyTitle' : 'closedTitle')}</h1>
      <p className="lead">{text(lobby ? 'tooEarlyLead' : 'closedLead')}</p>
    </div>
  );
}
