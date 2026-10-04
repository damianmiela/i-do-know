// /preview?as=phone: the real phone screen (question or reveal) for the draft being edited.
import { useEffect, useState } from 'react';
import type { Ack, GuestView } from '@idoknow/shared';
import { LangContext } from '../play/context';
import { QuestionScreen, Reveal } from '../play/Quiz';
import { listen, type PreviewMessage } from './message';
import '../flags.css';
import '../play/play.css';

function viewOf(m: PreviewMessage): GuestView {
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
    joined: true,
    joiningOpen: true,
    name: 'Guest',
    ...(reveal
      ? {
          correctOption: q.correct,
          myAnswer: q.correct,
          myPoints: 950,
          myAnswerMs: 2300,
          score: 950,
          rank: 1,
          correctCount: 1,
        }
      : {}),
  };
}

const noAck = (a: Ack) => a;

export default function PreviewPhone() {
  const [message, setMessage] = useState<PreviewMessage | null>(null);
  const [at] = useState(() => performance.now());
  useEffect(() => listen(setMessage), []);
  if (!message) return null;
  const props = { view: viewOf(message), receivedAt: at, now: at, connected: true, onAck: noAck };
  return (
    <LangContext.Provider value={message.lang}>
      {/* the question fits one screen like on a real phone (fitsScreen(); audit 9) */}
      <main className={`app phone preview${message.phase === 'reveal' ? '' : ' fit'}`}>
        {message.phase === 'reveal' ? <Reveal {...props} /> : <QuestionScreen {...props} />}
      </main>
    </LangContext.Provider>
  );
}
