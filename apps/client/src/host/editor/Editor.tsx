// The question editor (Phase 6.6), in the host panel: the questions of the quiz and of the
// warm-up round, each with every setting. Only in the waiting room: nothing changes under the
// guests' feet. The rules are the server's (questionProblems); the server checks them again.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ANSWER_TEXT_MAX,
  LANGS,
  QUESTION_TEXT_MAX,
  type Ack,
  type HostQuestion,
  type HostView,
  type Lang,
  type QuestionKind,
  type QuestionList,
  type HostQuestionLists,
  MAIN_SET,
  SET_NAME_MAX,
  WARMUP_LIST,
} from '@idoknow/shared';
import { LANG_NAMES } from '../../i18n';
import { LangFlag } from '../../play/Icon';
import { READY, type PreviewMessage } from '../../preview/message';
import { allLists } from '../logic';
import { socket } from '../../socket';
import {
  addOption,
  canAddOption,
  canRemoveOption,
  changeKind,
  duplicate,
  emptyDraft,
  fromHost,
  longIn,
  missing,
  problems,
  removeOption,
  setOption,
  setText,
  titleOf,
  toEdited,
  type Draft,
  type Sides,
} from './logic';
import type { Ask } from '../logic';
import { shrink, uploadPhoto } from './photo';
import './editor.css';

const REPLY_TIMEOUT_MS = 10_000;
const KINDS: [QuestionKind, string][] = [
  ['choice', 'Multiple choice (2–4 answers)'],
  ['bride-or-groom', 'Bride or groom'],
  ['photo', 'Photo question'],
];

export interface EditorProps {
  view: HostView;
  lists: HostQuestionLists;
  report: (done?: string) => (err: Error | null, reply?: Ack) => void;
  setAsk: (ask: Ask | null) => void;
  /** The panel frame (it hides the panel in other tabs on a phone). */
  frame: (title: string, children: ReactNode) => ReactNode;
}

export function Editor({ view, lists, report, setAsk, frame }: EditorProps) {
  const [picked, setList] = useState<QuestionList>(MAIN_SET);
  /** The open form, with the list it was opened in (audit 9: never saved into another one). */
  const [editing, setEditing] = useState<{
    draft: Draft;
    index?: number;
    list: QuestionList;
  } | null>(null);
  /** Naming a new set, or renaming the open one (null: not now). */
  const [naming, setNaming] = useState<{ id?: string; name: string } | null>(null);
  const locked = view.phase !== 'lobby' || !!view.warmup;
  const all = allLists(lists);
  // a set deleted (e.g. by another host) falls back to the main quiz
  const entry = all.find((l) => l.id === picked) ?? all[0]!;
  const list = entry.id;
  const items = entry.questions;
  const isSet = list !== MAIN_SET && list !== WARMUP_LIST;

  const saveName = () => {
    if (!naming) return;
    const done = (err: Error | null, reply?: Ack<{ id?: string }>) => {
      report(naming.id ? 'Set renamed.' : 'Set created.')(err, reply);
      if (!err && reply?.ok) {
        setNaming(null);
        if (reply.id) setList(reply.id);
      }
    };
    if (naming.id) {
      socket
        .timeout(REPLY_TIMEOUT_MS)
        .emit('host:setRename', { id: naming.id, name: naming.name }, done);
    } else {
      socket.timeout(REPLY_TIMEOUT_MS).emit('host:setCreate', { name: naming.name }, done);
    }
  };
  const deleteSet = () =>
    setAsk({
      title: `Delete the set "${entry.name}"?`,
      body: `Its ${items.length} question(s) are gone from questions.json (the file before is kept as questions.prev.json).`,
      choices: [
        {
          label: 'Delete set',
          tone: 'danger',
          run: () =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit('host:setDelete', { id: list }, report('Set deleted.')),
        },
      ],
    });

  const move = (q: HostQuestion, to: number) =>
    socket.timeout(REPLY_TIMEOUT_MS).emit('host:questionMove', { list, id: q.id, to }, report());
  const remove = (q: HostQuestion) =>
    setAsk({
      title: `Delete "${titleOf(q)}"?`,
      body: "It's gone from questions.json (the file before this change is kept as questions.prev.json).",
      choices: [
        {
          label: 'Delete question',
          tone: 'danger',
          run: () =>
            socket
              .timeout(REPLY_TIMEOUT_MS)
              .emit('host:questionDelete', { list, id: q.id }, report('Question deleted.')),
        },
      ],
    });

  // the form's set was deleted (on another host panel): the form closes, a line says why
  const target = editing && all.find((l) => l.id === editing.list);
  const setGone = !!editing && !target;

  if (editing && target && !locked) {
    return frame(
      `${target.name} · ${editing.draft.id ? 'edit question' : 'new question'}`,
      <DraftForm
        list={target.id}
        start={editing.draft}
        index={editing.index}
        timer={view.timeLimitSec}
        sides={view.sides}
        demo={!!view.demo}
        report={report}
        setAsk={setAsk}
        onDone={() => setEditing(null)}
      />,
    );
  }

  return frame(
    'Questions',
    <>
      {setGone && (
        <p className="h-muted" role="status">
          The question set you were editing was deleted (on another host panel?). Your changes were
          not saved.
        </p>
      )}
      <div className="e-lists" role="group" aria-label="Question list">
        {all.map((l) => (
          <button
            key={l.id}
            className={list === l.id ? 'on' : ''}
            onClick={() => {
              setList(l.id);
              setNaming(null); // a rename form belongs to the set it was opened for
              setEditing(null);
            }}
          >
            {l.name} <small>{l.questions.length}</small>
          </button>
        ))}
        {!locked && (
          <button
            onClick={() => setNaming({ name: '' })}
            title="A new set of questions for another round"
          >
            + New set
          </button>
        )}
      </div>
      {naming && !locked && (
        <form
          className="e-naming"
          onSubmit={(e) => {
            e.preventDefault();
            saveName();
          }}
        >
          <input
            className="h-input"
            value={naming.name}
            onChange={(e) => setNaming({ ...naming, name: e.target.value })}
            placeholder="Set name, e.g. Poland vs Spain"
            maxLength={SET_NAME_MAX}
            autoFocus
          />
          <button className="h-btn" disabled={!naming.name.trim()}>
            {naming.id ? 'Rename' : 'Create set'}
          </button>
          <button type="button" className="h-btn quiet" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}
      {isSet && !locked && !naming && (
        <div className="e-set-acts">
          <span className="h-muted">
            A set is played as its own round: pick it in the Game panel (&quot;Round&quot;).
          </span>
          <button className="h-btn small" onClick={() => setNaming({ id: list, name: entry.name })}>
            Rename set
          </button>
          <button className="h-btn small danger" onClick={deleteSet}>
            Delete set
          </button>
        </div>
      )}
      {list !== WARMUP_LIST && (
        // Phase 9.5: the bride and groom answer too; their answers are shown after the ranking
        <label className="h-switch e-couple">
          <input
            type="checkbox"
            checked={!!entry.couple}
            disabled={locked}
            onChange={(e) =>
              socket
                .timeout(REPLY_TIMEOUT_MS)
                .emit(
                  'host:setCouple',
                  { list, on: e.target.checked },
                  report(
                    e.target.checked ? 'The couple plays along.' : 'The couple sits this one out.',
                  ),
                )
            }
          />
          <span>
            <b>The couple plays along</b>
            <small>
              {view.coupleMarked.bride || view.coupleMarked.groom
                ? `${[view.coupleMarked.bride, view.coupleMarked.groom].filter(Boolean).join(' & ')} answer too, but stay off every ranking; after the full ranking the big screen goes through their answers.`
                : 'Mark the bride and groom in guests.json first ("role": "bride" / "groom"), then restart the server.'}
            </small>
          </span>
        </label>
      )}
      {locked && (
        <p className="h-muted">
          Questions can be edited only in the waiting room (not during the quiz or the warm-up).
        </p>
      )}
      <ol className="e-list">
        {items.map((q, i) => {
          const lacks = missing(q);
          return (
            <li key={q.id}>
              <span className="n">{i + 1}</span>
              <span className="t">
                {titleOf(q)}
                <small>
                  {KINDS.find(([k]) => k === q.kind)?.[1].split(' (')[0]} · answer:{' '}
                  <b>{titleOf({ text: q.options[q.correct]! })}</b>
                </small>
                {lacks.length > 0 && (
                  <small className="e-missing">
                    missing: {lacks.map((l) => l.toUpperCase()).join(', ')}
                  </small>
                )}
              </span>
              {!locked && (
                <span className="acts">
                  <button
                    className="h-btn small"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(q, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    className="h-btn small"
                    aria-label="Move down"
                    disabled={i === items.length - 1}
                    onClick={() => move(q, i + 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="h-btn small"
                    onClick={() => setEditing({ draft: fromHost(q), list })}
                  >
                    Edit
                  </button>
                  <button
                    className="h-btn small"
                    onClick={() => setEditing({ draft: duplicate(q), index: i + 1, list })}
                  >
                    Copy
                  </button>
                  <button className="h-btn small danger" onClick={() => remove(q)}>
                    Delete
                  </button>
                </span>
              )}
            </li>
          );
        })}
        {items.length === 0 && <li className="h-muted">No questions here yet.</li>}
      </ol>
      {!locked && (
        <button className="h-btn" onClick={() => setEditing({ draft: emptyDraft(), list })}>
          + Add a question
        </button>
      )}
    </>,
  );
}

function DraftForm({
  list,
  start,
  index,
  timer,
  sides,
  demo,
  report,
  setAsk,
  onDone,
}: {
  list: QuestionList;
  start: Draft;
  index?: number;
  /** The one countdown of every question (for the preview). */
  timer: number;
  /** The couple's names: a bride-or-groom question without answers starts with them. */
  sides: Sides;
  /** The public demo: photo uploads are off. */
  demo: boolean;
  report: EditorProps['report'];
  setAsk: EditorProps['setAsk'];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(start);
  const [lang, setLang] = useState<Lang>('en');
  const [saving, setSaving] = useState(false);
  const [photoState, setPhotoState] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewMessage['phase'] | null>(null);
  const blocking = problems(draft);
  const lacks = missing(draft);
  const long = longIn(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(start);

  const save = () => {
    if (saving || blocking.length) return;
    setSaving(true);
    socket
      .timeout(REPLY_TIMEOUT_MS)
      .emit(
        'host:questionSave',
        { list, question: toEdited(draft), ...(index !== undefined ? { index } : {}) },
        (err, reply) => {
          setSaving(false);
          report('Question saved.')(err, reply);
          if (!err && reply.ok) onDone();
        },
      );
  };
  const cancel = () =>
    changed
      ? setAsk({
          title: 'Leave without saving?',
          body: 'Your changes to this question are lost.',
          choices: [{ label: 'Leave without saving', tone: 'caution', run: onDone }],
        })
      : onDone();

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoState('Shrinking and uploading…');
    try {
      const name = await uploadPhoto(await shrink(file));
      setDraft((d) => ({ ...d, photo: name }));
      setPhotoState(null);
    } catch (e) {
      setPhotoState((e as Error).message || 'The photo could not be uploaded.');
    }
  };

  return (
    <div className="e-form">
      <label className="e-field">
        <span>Type</span>
        <select
          className="h-input"
          value={draft.kind}
          onChange={(e) => setDraft(changeKind(draft, e.target.value as QuestionKind, sides))}
        >
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </label>

      {draft.kind === 'photo' && (
        <div className="e-field">
          <span>Photo</span>
          <div className="e-photo">
            {draft.photo ? (
              <img src={`/photos/${encodeURIComponent(draft.photo)}`} alt="" />
            ) : (
              <span className="h-muted">No photo yet</span>
            )}
            {!demo && (
              <label className="h-btn">
                {draft.photo ? 'Change photo…' : 'Choose a photo…'}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => void pickPhoto(e.target.files?.[0])}
                />
              </label>
            )}
          </div>
          {photoState && <p className="h-muted">{photoState}</p>}
          <p className="h-muted">
            {demo
              ? 'Photo uploads are off in the public demo.'
              : 'It\u2019s made small (about 1200 px) before uploading and gets a neutral file name.'}
          </p>
        </div>
      )}

      <div className="e-langs" role="group" aria-label="Language">
        {LANGS.map((l) => (
          <button
            key={l}
            className={`${lang === l ? 'on' : ''}${lacks.includes(l) ? ' lacks' : ''}`}
            onClick={() => setLang(l)}
            title={LANG_NAMES[l] + (lacks.includes(l) ? ' (missing)' : '')}
          >
            <LangFlag lang={l} />
            {l.toUpperCase()}
          </button>
        ))}
      </div>

      <label className="e-field">
        <span>Question ({LANG_NAMES[lang]})</span>
        <textarea
          className="h-input e-text"
          lang={lang}
          maxLength={QUESTION_TEXT_MAX}
          value={draft.text[lang]}
          onChange={(e) => setDraft(setText(draft, lang, e.target.value))}
          rows={3}
        />
      </label>

      <fieldset className="e-answers">
        <legend>Answers ({LANG_NAMES[lang]}) · the right one is marked</legend>
        {draft.options.map((o, i) => (
          <div key={i} className="e-answer">
            <input
              type="radio"
              name="correct"
              aria-label={`Answer ${i + 1} is right`}
              checked={draft.correct === i}
              onChange={() => setDraft({ ...draft, correct: i })}
            />
            <input
              className="h-input"
              lang={lang}
              maxLength={ANSWER_TEXT_MAX}
              value={o[lang]}
              placeholder={`Answer ${i + 1}`}
              onChange={(e) => setDraft(setOption(draft, i, lang, e.target.value))}
            />
            {canRemoveOption(draft) && (
              <button
                className="h-btn small"
                aria-label={`Remove answer ${i + 1}`}
                onClick={() => setDraft(removeOption(draft, i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {canAddOption(draft) && (
          <button className="h-btn small" onClick={() => setDraft(addOption(draft))}>
            + Add an answer
          </button>
        )}
      </fieldset>

      {lacks.length > 0 && (
        <p className="e-note">
          Still missing: {lacks.map((l) => LANG_NAMES[l]).join(', ')}. You can save now; the quiz
          can&apos;t start until every language is filled in.
        </p>
      )}
      {long.length > 0 && (
        <p className="e-note">
          Long text in {long.map((l) => l.toUpperCase()).join(', ')}: the big screen shows it
          smaller. Shorter reads better from the back of the hall.
        </p>
      )}
      {blocking.length > 0 && (
        <ul className="e-problems" role="alert">
          {blocking.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="e-row">
        <button className="h-btn" onClick={() => setPreview(preview ? null : 'question')}>
          {preview ? 'Hide preview' : 'Preview'}
        </button>
        {preview && (
          <button
            className="h-btn"
            onClick={() => setPreview(preview === 'question' ? 'reveal' : 'question')}
          >
            Show {preview === 'question' ? 'the reveal' : 'the question'}
          </button>
        )}
      </div>
      {preview && <Preview draft={draft} lang={lang} phase={preview} timer={timer} />}

      <div className="e-row e-save">
        <button className="h-btn big" onClick={save} disabled={saving || blocking.length > 0}>
          {saving ? 'Saving…' : 'Save question'}
        </button>
        <button className="h-btn big quiet" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The real big screen and phone, in small frames, showing the draft as guests will see it. */
function Preview({
  draft,
  lang,
  phase,
  timer,
}: {
  draft: Draft;
  lang: Lang;
  phase: PreviewMessage['phase'];
  timer: number;
}) {
  const screen = useRef<HTMLIFrameElement>(null);
  const phone = useRef<HTMLIFrameElement>(null);
  const message: PreviewMessage = {
    type: 'ido-preview',
    question: draft,
    timeLimitSec: timer,
    lang,
    phase,
  };
  const latest = useRef(message);
  useEffect(() => {
    latest.current = message;
  });

  // send the draft on every change, and again when a frame says it's ready
  useEffect(() => {
    for (const frame of [screen.current, phone.current]) {
      frame?.contentWindow?.postMessage(message, window.location.origin);
    }
  });
  useEffect(() => {
    const onReady = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || (e.data as { type?: unknown })?.type !== READY) {
        return;
      }
      (e.source as Window | null)?.postMessage(latest.current, window.location.origin);
    };
    window.addEventListener('message', onReady);
    return () => window.removeEventListener('message', onReady);
  }, []);

  return (
    <div className="e-preview">
      <iframe ref={screen} className="e-screen" src="/preview?as=screen" title="Big screen" />
      <div className="e-phone-box">
        <iframe ref={phone} src="/preview?as=phone" title="Phone" />
      </div>
    </div>
  );
}
