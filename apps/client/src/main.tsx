import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { LoadFailed } from './LoadGuard';
import { view } from './socket';
import './theme.css';

// Each page loads only its own code: phones never download the host panel or the big screen.
// (The entry file itself is never hot-reloaded, so fast-refresh rules don't apply here.)
const path = window.location.pathname;
const previewAs = new URLSearchParams(window.location.search).get('as');
// eslint-disable-next-line react-refresh/only-export-components
const Page =
  view === 'play'
    ? lazy(() => import('./play/PlayApp'))
    : view === 'screen'
      ? lazy(() => import('./screen/ScreenApp'))
      : path === '/preview'
        ? previewAs === 'phone'
          ? lazy(() => import('./preview/PreviewPhone'))
          : lazy(() => import('./preview/PreviewScreen'))
        : lazy(() => import('./host/HostApp'));

// the site's front page (behind the login) is the host panel
if (!view && path !== '/preview') window.location.replace('/host');

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <LoadFailed>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </LoadFailed>
  </StrictMode>,
);
