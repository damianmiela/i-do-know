// The big screen (/screen): projector or TV, behind the admin login. It only shows what the
// server sends; the host drives everything from the host panel. Laid out once at 1920×1080 and
// scaled to the window, so it looks the same on any projector.
import { useEffect, useRef, useState } from 'react';
import { UNAUTHORIZED, type ScreenView } from '@idoknow/shared';
import { socket } from '../socket';
import { InstantContext } from '../motion';
import { useNow } from '../useNow';
import { st } from './texts';
import { stageScale, STAGE_HEIGHT, STAGE_WIDTH } from './logic';
import { Board } from './Screens';
import '../flags.css';
import './screen.css';

/** The stage scale for the current window size. */
function useStageScale(): number {
  const [scale, setScale] = useState(() => stageScale(window.innerWidth, window.innerHeight));
  useEffect(() => {
    const onResize = () => setScale(stageScale(window.innerWidth, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return scale;
}

/** True after the mouse has been still for a few seconds: hide the cursor and the buttons. */
function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    window.addEventListener('mousemove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [ms]);
  return idle;
}

interface WakeLock {
  release: () => Promise<void>;
}

/** Keeps the laptop driving the projector from dimming or sleeping during the evening. */
function useKeepAwake() {
  useEffect(() => {
    let lock: WakeLock | null = null;
    const api = (navigator as { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } })
      .wakeLock;
    const request = () => {
      if (!api || document.visibilityState !== 'visible') return;
      api.request('screen').then(
        (l) => (lock = l),
        () => {}, // not allowed or not supported: set the laptop's power settings instead
      );
    };
    request();
    document.addEventListener('visibilitychange', request); // dropped whenever hidden
    return () => {
      document.removeEventListener('visibilitychange', request);
      lock?.release().catch(() => {});
    };
  }, []);
}

const toggleFullscreen = () => {
  const done = () => {}; // refused (e.g. not started by a key or click): nothing to do
  if (document.fullscreenElement) document.exitFullscreen().catch(done);
  else document.documentElement.requestFullscreen().catch(done);
};

export default function ScreenApp() {
  const [view, setView] = useState<ScreenView | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [connected, setConnected] = useState(socket.connected);
  const [refused, setRefused] = useState(false);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  // the first view after a (re)connect shows the state as it is; animations start with the next
  // step (a new question, the reveal, a podium place…)
  const [instant, setInstant] = useState(true);
  const fresh = useRef(true);
  const lastStep = useRef('');
  const scale = useStageScale();
  const idle = useIdle(3_000);
  useKeepAwake();

  useEffect(() => {
    const onView = (v: ScreenView) => {
      const base = `${v.warmup ? 'w' : 'q'}.${v.phase}.${v.questionNumber}.${v.podiumShown}`;
      // what covers the live game: a past game or a ranking (the host can show and hide them)
      const cover = v.past
        ? `past.${v.past.id}.${v.past.question ?? 'top'}`
        : v.couple
          ? `couple.${v.couple.n ?? 'sum'}`
          : v.ranking
            ? 'ranking'
            : '';
      const step = `${base}|${cover}`;
      const [lastBase, lastCover] = lastStep.current.split('|');
      if (fresh.current) setInstant(true);
      else if (base !== lastBase) setInstant(false);
      // back to the same live screen (e.g. the podium after the overall ranking): nothing
      // replays, no second confetti (audit 9); a new cover gets its entrance
      else if (cover !== lastCover) setInstant(cover === '');
      fresh.current = false;
      lastStep.current = step;
      setView(v);
      setReceivedAt(performance.now());
    };
    const onConnect = () => {
      fresh.current = true;
      setConnected(true);
    };
    const onDisconnect = () => setConnected(false);
    // anything else is a network problem: Socket.IO keeps retrying by itself
    const onError = (err: Error) => setRefused(err.message === UNAUTHORIZED);
    const onFullscreen = () => setFullscreen(!!document.fullscreenElement);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    socket.on('state:screen', onView);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('keydown', onKey);
    socket.connect(); // after the listeners, so the first state isn't missed
    return () => {
      socket.off('state:screen', onView);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (view) document.documentElement.lang = view.lang;
  }, [view]);

  const counting = view?.phase === 'question' && !view.paused;
  const now = useNow(counting);
  const lang = view?.lang ?? 'en';

  return (
    <div className={`screen-page${idle ? ' idle' : ''}`}>
      <div
        className="stage"
        style={{
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {refused ? (
          <div className="s-center">
            <img className="s-logo-big" src="/brand/logo-light.webp" alt="I Do! (know)" />
            <a className="s-lead" href="/login?next=/screen">
              {st(lang, 'loggedOut')}
            </a>
          </div>
        ) : view ? (
          <InstantContext.Provider value={instant}>
            {/* a new screen per question (also after a skip), so each one gets its entrance */}
            <Board
              key={`${view.warmup ? 'w' : 'q'}.${view.phase}.${view.questionNumber}.${view.past ? `${view.past.id}.${view.past.question ?? 'top'}` : 'live'}${view.ranking ? '.ranking' : ''}${view.couple ? `.couple.${view.couple.n ?? 'sum'}` : ''}`}
              view={view}
              receivedAt={receivedAt}
              now={now}
            />
          </InstantContext.Provider>
        ) : (
          <div className="s-center">
            <img className="s-logo-big" src="/brand/logo-light.webp" alt="I Do! (know)" />
          </div>
        )}
        {view && !connected && !refused && (
          <div className="s-offline" role="status">
            {st(lang, 'reconnecting')}
          </div>
        )}
      </div>
      {!fullscreen && !idle && (
        <button className="fs-button" onClick={toggleFullscreen}>
          {st(lang, 'fullscreen')}
        </button>
      )}
    </div>
  );
}
