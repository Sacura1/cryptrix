import { useState } from 'react';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../context';
import { short } from '../types';
import { Icon } from './ui';
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
            ['/guide', 'For agents'],
          ].map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenu(false)}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="header-actions">
          <Link className="button secondary" to="/guide">For agents</Link>
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
      {config?.mode === 'paid' && config.chainId === 5042002 && (
        <div className="environment-bar">
          <span className="outline-tag">ARC TESTNET</span> Test USDC only.
        </div>
      )}
      {configError && (
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
      </nav>
    </>
  );
}
