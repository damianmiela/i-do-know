// /preview?as=screen: the real big-screen question (or reveal) for the draft being edited.
import { useEffect, useState } from 'react';
import type { ScreenView } from '@idoknow/shared';
import { InstantContext } from '../motion';
import { stageScale, STAGE_HEIGHT, STAGE_WIDTH } from '../screen/logic';
import { Board } from '../screen/Screens';
import { listen, type PreviewMessage } from './message';
import '../flags.css';
import '../screen/screen.css';

function viewOf(m: PreviewMessage): ScreenView {
  const q = m.question;
  const reveal = m.phase === 'reveal';
  return {
    phase: m.phase,
    questionNumber: 1,
    questionCount: 1,
    question: {
      id: 'preview',
      kind: q.kind,
      text: q.text,
      options: q.options,
      timeLimitSec: m.timeLimitSec,
      ...(q.photo ? { photo: q.photo } : {}),
    },
    timeLeftMs: m.timeLimitSec * 1000,
    paused: false,
    playerCount: 12,
    answeredCount: reveal ? 12 : 0,
    lang: m.lang,
    joiningOpen: true,
    podiumShown: 0,
    ...(reveal
      ? {
          correctOption: q.correct,
          optionCounts: q.options.map((_, i) => (i === q.correct ? 7 : 2 - (i % 2))),
        }
      : {}),
  };
}

export default function PreviewScreen() {
  const [message, setMessage] = useState<PreviewMessage | null>(null);
  const [scale, setScale] = useState(() => stageScale(window.innerWidth, window.innerHeight));
  const [at] = useState(() => performance.now());
  useEffect(() => listen(setMessage), []);
  useEffect(() => {
    const onResize = () => setScale(stageScale(window.innerWidth, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return (
    <div className="screen-page preview">
      <div
        className="stage"
        style={{
          width: STAGE_WIDTH,
          height: STAGE_HEIGHT,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {message && (
          // a preview never animates: it changes with every key the host types
          <InstantContext.Provider value>
            <Board view={viewOf(message)} receivedAt={at} now={at} />
          </InstantContext.Provider>
        )}
      </div>
    </div>
  );
}
