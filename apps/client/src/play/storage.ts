// Small settings kept on the phone. localStorage can be missing or blocked (private mode on
// some phones): then the phone simply asks again, nothing breaks.

export function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore: the setting just isn't remembered
  }
}

export const KEYS = {
  /** The guest's language. */
  lang: 'ido-lang',
  /** "1" once the guest confirmed a language on this phone. */
  langChosen: 'ido-lang-chosen',
} as const;
