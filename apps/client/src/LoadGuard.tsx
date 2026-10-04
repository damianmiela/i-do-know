// Keeps the page from going blank when its code fails to download on a weak connection.
import { Component, type ReactNode } from 'react';
import { detectLang, t } from './i18n';

const RELOADED_AT = 'ido-reloaded-at';
/** At most one automatic reload in this time: an error that a reload can't fix never loops. */
const RELOAD_EVERY_MS = 5 * 60_000;

function reloadedRecently(now: number): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOADED_AT));
    if (at && now - at < RELOAD_EVERY_MS) return true;
    sessionStorage.setItem(RELOADED_AT, String(now));
    return false;
  } catch {
    return true; // no storage: no automatic reload (it could loop), the button is the way out
  }
}

/**
 * On a weak connection the page's code can fail to download. Then reload by itself (once in a
 * few minutes), and otherwise show a button instead of an empty page.
 */
export class LoadFailed extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    if (!reloadedRecently(Date.now())) window.location.reload();
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const lang = detectLang(navigator.languages ?? [navigator.language]);
    // inline styles: the page's own CSS may be exactly what failed to load
    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'var(--night)',
          fontFamily: 'var(--f-body)',
        }}
      >
        <button
          onClick={() => window.location.reload()}
          style={{
            font: 'inherit',
            fontSize: 20,
            fontWeight: 800,
            maxWidth: 420,
            padding: '18px 24px',
            border: 0,
            borderRadius: 'var(--r-md)',
            background: 'var(--gold)',
            color: 'var(--ink)',
          }}
        >
          {t(lang, 'reload')}
        </button>
      </main>
    );
  }
}
