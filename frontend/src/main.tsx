import React, { Suspense, lazy, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useLocation, Link } from 'react-router-dom';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-500.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import '@fontsource/barlow-condensed/latin-800.css';
import './styles.css';
import './combat.css';
import './spectator.css';
import './mining.css';
import './mine-preview.css';
import './rush-hud.css';
import './agent-avatars.css';
import './arena-pages.css';
import { AppProvider } from './context';
import { Layout } from './components/Layout';
import { Loading } from './components/ui';
import { installGameAudio } from './lib/browser-audio';
const removeAudioActivation = installGameAudio();
if (import.meta.hot) import.meta.hot.dispose(removeAudioActivation);
const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })));
const Live = lazy(() => import('./pages/Live').then((m) => ({ default: m.Live })));
const localTestPages = import.meta.env.DEV
  ? import.meta.glob<{ LiveModelTest: React.ComponentType }>('./pages/LiveModelTest.tsx')
  : {};
const loadLocalTest = localTestPages['./pages/LiveModelTest.tsx'];
const LiveModelTest = loadLocalTest
  ? lazy(() => loadLocalTest().then((m) => ({ default: m.LiveModelTest })))
  : undefined;
const MatchPage = lazy(() => import('./pages/Match').then((m) => ({ default: m.MatchPage })));
const Agents = lazy(() => import('./pages/AgentDirectory').then((m) => ({ default: m.Agents })));
const AgentPage = lazy(() => import('./pages/AgentProfile').then((m) => ({ default: m.AgentPage })));
const Guide = lazy(() => import('./pages/AgentGuide').then((m) => ({ default: m.Guide })));
const ArenaStats = lazy(() => import('./pages/ArenaStats').then((m) => ({ default: m.ArenaStats })));
function Scroll() {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView());
    } else window.scrollTo(0, 0);
    document.title =
      pathname === '/'
        ? 'Cryptrix — strategy on the line'
        : `${pathname.startsWith('/agents') ? 'Agents' : pathname.startsWith('/live') ? 'Live games' : pathname.startsWith('/guide') ? 'Field guide' : pathname.startsWith('/stats') ? 'Arena stats' : 'Arena'} — Cryptrix`;
  }, [pathname, hash]);
  return null;
}
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    const practiceViewer =
      location.pathname.startsWith('/demo/') ||
      location.pathname === '/test/cache-rush' ||
      new URLSearchParams(location.search).get('model-test') === '1';
    return this.state.failed ? (
      <div className="page empty">
        <h1>The page hit a snag.</h1>
        <p>
          {practiceViewer
            ? 'Reload to reconnect to the game.'
            : 'Reload to reconnect. A submitted wallet transaction may still confirm; check its receipt before sending again.'}
        </p>
        <button className="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
const root: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.data.root = root;
root.render(
  <React.StrictMode>
    <Boundary>
      <BrowserRouter>
        <AppProvider>
          <Scroll />
          <Suspense fallback={<Loading text="Opening the arena…" />}>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="live" element={<Live />} />
                {import.meta.env.DEV && LiveModelTest && (
                  <Route path="test/cache-rush" element={<LiveModelTest />} />
                )}
                <Route path="matches/:id" element={<MatchPage />} />
                <Route path="matches/:id/replay" element={<MatchPage />} />
                {import.meta.env.DEV && <Route path="demo/:game" element={<MatchPage />} />}
                <Route path="agents" element={<Agents />} />
                <Route path="agents/:id" element={<AgentPage />} />
                <Route path="guide" element={<Guide />} />
                <Route path="stats" element={<ArenaStats />} />
                <Route
                  path="*"
                  element={
                    <div className="page empty">
                      <span className="eyebrow">404 / OFF THE FIELD</span>
                      <h1>This arena doesn’t exist.</h1>
                      <Link to="/" className="button">
                        Back home
                      </Link>
                    </div>
                  }
                />
              </Route>
            </Routes>
          </Suspense>
        </AppProvider>
      </BrowserRouter>
    </Boundary>
  </React.StrictMode>,
);
