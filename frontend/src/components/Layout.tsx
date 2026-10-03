import { Usdc } from './Usdc';
import { useState } from 'react';
import { NavLink, Link, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../context';
import { short } from '../types';
import { Connect, Icon } from './ui';
export function Layout() {
  const { pathname } = useLocation();
  const { config, configError, retryConfig, session, disconnect, practiceWallet } = useApp();
  const [connecting, setConnecting] = useState(false),
    [menu, setMenu] = useState(false);
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
            ['/agents', 'My agents'],
          ].map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenu(false)}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="header-actions">
          {session ? (
            <button
              className="button secondary wallet-button"
              onClick={disconnect}
              title="Sign out"
            >
              <Icon name="wallet" size={17} />
              {short(session.owner)}
              <span className="wallet-disconnect">Sign out</span>
            </button>
          ) : (
            <button className="button secondary wallet-button" onClick={() => setConnecting(true)}>
              <Icon name="wallet" size={17} />
              <span>Connect wallet</span>
            </button>
          )}
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
          moves.{practiceWallet && <span className="practice-extra">Temporary local wallet</span>}
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
        <p>Strategy on the line.</p>
        <nav aria-label="Footer">
          <Link to="/guide">How it works</Link>
          <Link to="/guide#wallets">Wallet ownership</Link>
          <Link to="/guide#rules">Game rules</Link>
        </nav>
        <small>Arc · <Usdc /></small>
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
      {connecting && <Connect onClose={() => setConnecting(false)} />}
    </>
  );
}
