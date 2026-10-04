// The question editor's preview: the host panel sends the draft to /preview frames by postMessage.
import type { EditedQuestion, Lang } from '@idoknow/shared';

export interface PreviewMessage {
  type: 'ido-preview';
  question: EditedQuestion;
  /** The one countdown of every question (the host's timer). */
  timeLimitSec: number;
  lang: Lang;
  phase: 'question' | 'reveal';
}

/** A preview frame tells its parent it's ready (the parent then sends the current draft). */
export const READY = 'ido-preview-ready';

/** Only messages from this site, of the right kind. */
export function isPreviewMessage(e: MessageEvent): e is MessageEvent<PreviewMessage> {
  return (
    e.origin === window.location.origin &&
    typeof e.data === 'object' &&
    e.data !== null &&
    (e.data as { type?: unknown }).type === 'ido-preview'
  );
}

/** Listens for drafts; returns the stop function. Tells the parent frame it's ready. */
export function listen(onMessage: (m: PreviewMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (isPreviewMessage(e)) onMessage(e.data);
  };
  window.addEventListener('message', handler);
  window.parent.postMessage({ type: READY }, window.location.origin);
  return () => window.removeEventListener('message', handler);
}
