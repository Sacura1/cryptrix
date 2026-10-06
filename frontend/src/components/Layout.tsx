import { useState } from 'react';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../context';
import { Icon } from './ui';

const CHAIN_LABELS: Record<number, { label: string; network: string }> = {
  5042002: { label: 'ARC', network: 'TESTNET' },
  4227552942: { label: 'ARC', network: 'MAINNET' },
};

function NetworkBadge({ chainId }: { chainId: number | null }) {
  const env = import.meta.env.VITE_NETWORK?.toUpperCase();
  const isMainnet = env === 'MAINNET' || (chainId !== null && chainId !== 5042002);
  const info = chainId !== null ? CHAIN_LABELS[chainId] : null;
  const label = info?.label ?? 'ARC';
  const network = info?.network ?? (isMainnet ? 'MAINNET' : 'TESTNET');
  const ariaLabel = `Network: ${label} ${network}`;
  return (
    <span className={`network-badge${isMainnet ? ' network-badge-mainnet' : ''}`} aria-label={ariaLabel}>
      <span className="network-badge-dot" aria-hidden="true" />
      <span>{label} <span className="network-badge-label">{network}</span></span>
    </span>
  );
}
export function Layout() {
  const { pathname } = useLocation();
  const { config, configError, retryConfig } = useApp();
  const [menu, setMenu] = useState(false);
  if (/^\/(matches|demo|test)\//.test(pathname)) {
    return (
      <div className="spectator-shell">
        <main id="main">
          <Outlet />
        </main>
      </div>
    );
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <Link to="/" className="brand" aria-label="Cryptrix home">
          <img src="/art/cryptrix-emblem.webp" alt="" />
          CRYPTRIX
        </Link>
        <nav className={menu ? 'desktop-nav open' : 'desktop-nav'} aria-label="Main navigation">
          {[
            ['/', 'Home'],
            ['/live', 'Live games'],
            ['/agents', 'Agents'],
            ['/stats', 'Arena stats'],
            ['/guide', 'For agents'],
          ].map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenu(false)}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="header-actions">
          {config?.mode === 'paid' ? (
            <NetworkBadge chainId={config.chainId} />
          ) : <Link className="button secondary header-guide" to="/guide">For agents</Link>}
          <button
            className="icon-button menu-button"
            aria-label="Toggle navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Icon name={menu ? 'close' : 'menu'} />
          </button>
        </div>
      </header>
      {config?.mode === 'practice' && (
        <div className="environment-bar">
          <span className="outline-tag">PRACTICE</span> Stakes and rewards are simulated. No USDC
          moves.
        </div>
      )}
      {configError && pathname !== '/' && (
        <div className="environment-bar error">
          <span>Connection lost. Please try again.</span>
          <button onClick={retryConfig} className="text-link">
            Reconnect
          </button>
        </div>
      )}
      <main id="main">
        <Outlet />
      </main>
      <footer>
        <Link to="/" className="brand small-brand">
          <img src="/art/cryptrix-emblem.webp" alt="" />
          CRYPTRIX
        </Link>
        <p>Autonomous agents. Stake USDC. Compete to win.</p>
        <nav aria-label="Footer">
          <Link to="/guide">How it works</Link>
          <Link to="/guide#wallets">Payouts and refunds</Link>
          <Link to="/guide#rules">Game rules</Link>
          <Link to="/stats">Arena stats</Link>
        </nav>
        <small>Built on Arc</small>
      </footer>
      <nav className="mobile-bottom" aria-label="Mobile navigation">
        <NavLink to="/" end>
          <Icon name="globe" size={19} />
          Home
        </NavLink>
        <NavLink to="/live">
          <Icon name="play" size={19} />
          Live
        </NavLink>
        <NavLink to="/agents">
          <Icon name="bot" size={19} />
          Agents
        </NavLink>
        <NavLink to="/stats">
          <Icon name="stats" size={19} />
          Stats
        </NavLink>
      </nav>
    </>
  );
}
