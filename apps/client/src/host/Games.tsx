// Past games (Phase 6.8): every finished real game, saved on the server (data/games). The host
// goes through one (the ranking; per question the votes and who answered what, and when),
// downloads it (JSON, or CSV for a spreadsheet), shows it on the big screen, or deletes it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Ack, GameRecord, GameSummary, HostView, Localized } from '@idoknow/shared';
import { CountryFlag } from '../play/Icon';
import { socket } from '../socket';
import { canShowPast, gameWhen, seconds, voteCounts, type Ask } from './logic';

const REPLY_TIMEOUT_MS = 10_000;
const en = (t: Localized) => t.en || Object.values(t).find(Boolean) || '';

interface GamesProps {
  view: HostView;
  report: (done?: string) => (err: Error | null, reply?: Ack) => void;
  setAsk: (ask: Ask | null) => void;
  frame: (title: string, children: ReactNode) => ReactNode;
}

export function Games({ view, report, setAsk, frame }: GamesProps) {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [open, setOpen] = useState<GameRecord | null>(null);
  // the panel re-renders often (the clock): keep the latest report without reloading
  const reported = useRef(report);
  useEffect(() => {
    reported.current = report;
  });

  const load = useCallback(() => {
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:games', (err, reply) => {
      if (!err && reply.ok) setGames(reply.games);
      else reported.current()(err, reply);
    });
  }, []);
  // on opening, and whenever a game has just ended (it's saved at the final)
  const ended = view.phase === 'final' && !view.warmup;
  useEffect(load, [load, ended]);

  const openGame = (id: string) =>
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:game', { id }, (err, reply) => {
      if (!err && reply.ok) setOpen(reply.game);
      else report()(err, reply);
    });
  const show = (id: string, question?: number) =>
    socket
      .timeout(REPLY_TIMEOUT_MS)
      .emit(
        'host:showPast',
        { id, ...(question !== undefined ? { question } : {}) },
        report('On the big screen.'),
      );
  const remove = (g: { id: string; finishedAt: number }) =>
    setAsk({
      title: `Delete the game of ${gameWhen(g.finishedAt)}?`,
      body: "Its file in data/games is removed: the answers and the ranking are gone for good. You can't undo this.",
      choices: [
        {
          label: 'Delete game',
          tone: 'danger',
          run: () =>
            socket.timeout(REPLY_TIMEOUT_MS).emit('host:gameDelete', { id: g.id }, (err, reply) => {
              report('Game deleted.')(err, reply);
              if (open?.id === g.id) setOpen(null);
              load();
            }),
        },
      ],
    });

  const showable = canShowPast(view);

  if (open) {
    return frame(
      `Past game · ${gameWhen(open.finishedAt)}${open.setName ? ` · ${open.setName}` : ''}`,
      <GameDetail
        game={open}
        showable={showable}
        onBack={() => setOpen(null)}
        onShow={(question) => show(open.id, question)}
        onDelete={() => remove(open)}
      />,
    );
  }

  return frame(
    'Past games',
    <>
      {games === null ? (
        <p className="h-muted">Loading…</p>
      ) : games.length === 0 ? (
        <p className="h-muted">
          No finished games yet. A game is saved when it reaches the podium.
        </p>
      ) : (
        <ul className="g-list">
          {games.map((g) => (
            <li key={g.id}>
              <span className="who">
                {gameWhen(g.finishedAt)}
                {g.setName && ` · ${g.setName}`}
                <small>
                  {g.playerCount} players · {g.questionCount} questions
                  {g.winners.length > 0 && ` · won by ${g.winners.join(', ')}`}
                </small>
              </span>
              <span className="acts">
                <button className="h-btn small" onClick={() => openGame(g.id)}>
                  Open
                </button>
                <button
                  className="h-btn small"
                  disabled={!showable}
                  title={showable ? undefined : 'Only in the waiting room or after the quiz'}
                  onClick={() => show(g.id)}
                >
                  Show on screen
                </button>
                <button className="h-btn small danger" onClick={() => remove(g)}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <button className="h-btn" onClick={load}>
        Refresh
      </button>
    </>,
  );
}

function GameDetail({
  game,
  showable,
  onBack,
  onShow,
  onDelete,
}: {
  game: GameRecord;
  showable: boolean;
  onBack: () => void;
  /** Shows the ranking (no question) or one question's votes on the big screen. */
  onShow: (question?: number) => void;
  onDelete: () => void;
}) {
  const notNow = showable ? undefined : 'Only in the waiting room or after the quiz';
  return (
    <>
      <div className="g-actions">
        <button className="h-btn small" onClick={onBack}>
          ← All games
        </button>
        <button
          className="h-btn small"
          disabled={!showable}
          title={notNow}
          onClick={() => onShow()}
        >
          Show the ranking on screen
        </button>
        <a className="h-btn small" href={`/host/games/${game.id}.csv`} download>
          CSV
        </a>
        <a className="h-btn small" href={`/host/games/${game.id}.json`} download>
          JSON
        </a>
        <button className="h-btn small danger" onClick={onDelete}>
          Delete
        </button>
      </div>

      <h3 className="g-h">Ranking · {game.players.length} players</h3>
      <ol className="h-top10">
        {game.players.map((p) => (
          <li key={p.id}>
            <span className="n">{p.rank}</span>
            {p.country ? <CountryFlag code={p.country} /> : <span />}
            <span className="who">{p.name}</span>
            <span className="pts">{p.score}</span>
            <small>
              {p.correctCount}/{game.questions.length}
            </small>
          </li>
        ))}
      </ol>

      <h3 className="g-h">Questions · timer {game.timeLimitSec} s</h3>
      {game.questions.map((q, i) => {
        const counts = voteCounts(q);
        const most = Math.max(1, ...counts);
        return (
          <details key={`${q.id}-${i}`} className="g-q">
            <summary>
              <b>
                {i + 1}. {en(q.text)}
              </b>
              <small>
                answer: {en(q.options[q.correct]!)} · {q.answers.length} answered
                {q.skipped && ' · skipped'}
              </small>
            </summary>
            <ul className="g-votes">
              {q.options.map((o, k) => (
                <li key={k} className={k === q.correct ? 'right' : ''}>
                  <span>
                    {k === q.correct ? '✓ ' : ''}
                    {en(o)}
                  </span>
                  <i style={{ width: `${(counts[k]! / most) * 100}%` }} />
                  <b>{counts[k]}</b>
                </li>
              ))}
            </ul>
            <button
              className="h-btn small"
              disabled={!showable}
              title={notNow}
              onClick={() => onShow(i)}
            >
              Show these votes on screen
            </button>
            {/* fastest first (the server keeps them in that order) */}
            <table className="g-answers">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Answer</th>
                  <th>Time</th>
                  <th>Points</th>
                </tr>
              </thead>
              <tbody>
                {q.answers.map((a) => (
                  <tr key={a.playerId} className={a.option === q.correct ? 'right' : ''}>
                    <td>{a.name}</td>
                    <td>{en(q.options[a.option] ?? ({} as Localized))}</td>
                    <td>{seconds(a.elapsedMs)}</td>
                    <td>{a.points}</td>
                  </tr>
                ))}
                {q.answers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="h-muted">
                      Nobody answered.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </details>
        );
      })}
    </>
  );
}
