// Joining: 1 pick your language, 2 find your name (and confirm it). That's all: the wristband
// comes with collect mode (Phase 7), if there are wristbands.
import { useEffect, useMemo, useState } from 'react';
import { foldText, LANGS, type Ack, type Lang, type NameMatch } from '@idoknow/shared';
import type { Key } from '../i18n';
import { LANG_NAMES } from '../i18n';
import { socket } from '../socket';
import { useText } from './context';
import { CountryFlag, Icon, LangFlag } from './Icon';
import { newestOnly, REPLY_TIMEOUT_MS } from './logic';

/** Server errors the guest can act on, as texts. Anything else: "something went wrong". */
function errorText(error: string): Key {
  const known: Record<string, Key> = { 'rate-limited': 'rateLimited', 'name-taken': 'nameTaken' };
  return known[error] ?? 'error';
}

const SEARCH_DELAY_MS = 250;

export function LanguageStep({
  name,
  lang,
  onPick,
  onDone,
}: {
  /** Set when changed later from the top bar ("Hi Łukasz! …"). */
  name: string | undefined;
  lang: Lang;
  onPick: (l: Lang) => void;
  onDone: () => void;
}) {
  const text = useText();
  return (
    <>
      <h1 className="h-phone">
        {name ? text('langTitle', { name: name.split(' ')[0]! }) : text('pickLanguage')}
      </h1>
      <div className="langs" role="radiogroup" aria-label={text('language')}>
        {LANGS.map((l) => (
          <button
            key={l}
            className={`lang${l === lang ? ' on' : ''}`}
            role="radio"
            aria-checked={l === lang}
            lang={l}
            onClick={() => onPick(l)}
          >
            <LangFlag lang={l} />
            {LANG_NAMES[l]}
            {l === lang && <Icon name="check" />}
          </button>
        ))}
      </div>
      <div className="grow" />
      <button className="btn" onClick={onDone}>
        {text('continue')}
      </button>
    </>
  );
}

export function NameSearch({ onAck }: { onAck: (r: Ack) => Ack }) {
  const text = useText();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NameMatch[] | null>(null);
  const [message, setMessage] = useState<Key | null>(null);
  /** The query the latest reply belongs to: while it differs from `query`, we're searching. */
  const [answeredFor, setAnsweredFor] = useState('');
  const [chosen, setChosen] = useState<NameMatch | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useMemo(() => newestOnly(), []);
  const firstWord = foldText(query).split(' ')[0] ?? '';
  const searchable = firstWord.length >= 2; // the same rule as the server
  const searching = searchable && answeredFor !== query;

  useEffect(() => {
    if (!searchable) return;
    const n = seq.next();
    const timer = setTimeout(() => {
      socket.timeout(REPLY_TIMEOUT_MS).emit('guest:search', { query }, (err, reply) => {
        if (!seq.isLatest(n)) return; // an older query answered late: ignore it
        setAnsweredFor(query);
        if (err) return setMessage('error'); // no reply: typing again searches again
        onAck(reply);
        setResults(reply.ok ? reply.results : null);
        setMessage(reply.ok ? null : errorText(reply.error));
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, searchable, seq, onAck]);

  const claim = (m: NameMatch) => {
    setBusy(true);
    socket.timeout(REPLY_TIMEOUT_MS).emit('guest:claim', { guestId: m.id }, (err, reply) => {
      setBusy(false);
      if (err) return setMessage('error');
      if (onAck(reply).ok) return; // the server sends the joined view: the lobby follows
      setChosen(null);
      if (!reply.ok) setMessage(errorText(reply.error));
      if (!reply.ok && reply.error === 'name-taken') {
        setResults((rs) => rs?.map((r) => (r.id === m.id ? { ...r, taken: true } : r)) ?? null);
      }
    });
  };

  // "Is this you?": one extra tap, so a shaky finger doesn't lock in someone else's name
  if (chosen) {
    return (
      <div className="grow center">
        <h1 className="h-phone">{text('confirmTitle')}</h1>
        <div className="surface wide confirm-name">
          <span className="big-name">{chosen.name}</span>
          <CountryFlag code={chosen.country} />
        </div>
        <button className="btn" disabled={busy} onClick={() => claim(chosen)}>
          {text('confirmYes')}
        </button>
        <button className="btn quiet" disabled={busy} onClick={() => setChosen(null)}>
          {text('confirmNo')}
        </button>
      </div>
    );
  }

  return (
    <>
      <h1 className="h-phone">{text('searchTitle')}</h1>
      <label className="field">
        <Icon name="search" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={text('searchPlaceholder')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="search"
          maxLength={50}
          aria-label={text('searchTitle')}
        />
      </label>
      {message && (
        <p className="notice" role="alert">
          {text(message)}
        </p>
      )}
      <div className="names grow">
        {!searchable && <p className="caption">{text('searchHint')}</p>}
        {searchable && searching && <p className="caption">{text('searching')}</p>}
        {searchable && !searching && results?.length === 0 && (
          <p className="caption">{text('searchNone')}</p>
        )}
        {searchable &&
          results?.map((m) => (
            <button key={m.id} className="name" disabled={m.taken} onClick={() => setChosen(m)}>
              <span>
                {m.name}
                {m.taken && (
                  <>
                    <br />
                    <small>{text('searchTaken')}</small>
                  </>
                )}
              </span>
              <CountryFlag code={m.country} />
            </button>
          ))}
      </div>
      <p className="caption center-text">{text('searchNotOnList')}</p>
    </>
  );
}
