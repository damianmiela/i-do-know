// Shared by the phone screens: the guest's language, and what every quiz screen gets.
import { createContext, useContext } from 'react';
import type { Ack, GuestView, Lang } from '@idoknow/shared';
import { t, type Key } from '../i18n';

export const LangContext = createContext<Lang>('en');

export const useLang = () => useContext(LangContext);

/** The text function for the guest's language. */
export function useText() {
  const lang = useContext(LangContext);
  return (key: Key, vars?: Record<string, string | number>) => t(lang, key, vars);
}

/** What every quiz screen gets. */
export interface ScreenProps {
  view: GuestView;
  /** performance.now() when `view` arrived, for the local countdown. */
  receivedAt: number;
  /** performance.now(), updated a few times a second while a question runs. */
  now: number;
  connected: boolean;
  /** Handles errors every action can get (e.g. an old join link). Returns the ack for more. */
  onAck: (result: Ack) => Ack;
}
