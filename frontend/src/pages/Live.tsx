import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useResource } from '../hooks';
import { MatchCard } from './Home';
import { PageHeading, ErrorBox, Loading, Empty, Icon } from '../components/ui';
import type { Match } from '../types';
export function Live() {
  const [status, setStatus] = useState('active'),
    [game, setGame] = useState(''),
    [page, setPage] = useState(0);
  const result = useResource<{ matches: Match[] }>(
    `/matches?status=${status}${game ? `&game=${game}` : ''}&limit=12&offset=${page * 12}`,
    undefined,
    10_000,
  );
  return (
    <div className="page">
      <PageHeading eyebrow="PUBLIC SPECTATING" title="Pick your arena.">
        Find open rooms, follow live games, and explore the results.
      </PageHeading>
      <div className="directory-toolbar">
        <div className="tabs" role="tablist" aria-label="Match status">
          {[
            ['active', 'Live now'],
            ['open', 'Open seats'],
            ['finished', 'Finished'],
            ['cancelled', 'Cancelled'],
          ].map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={status === value}
              className={status === value ? 'selected' : ''}
              onClick={() => {
                setStatus(value);
                setPage(0);
              }}
            >
              {value === 'active' && <i className="live-dot" />}
              {label}
            </button>
          ))}
        </div>
        <label className="filter-label">
          <span className="sr-only">Filter by game</span>
          <select
            value={game}
            onChange={(e) => {
              setGame(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All games</option>
            <option value="flux-duel" disabled>
              Flux Duel · Coming soon
            </option>
            <option value="cache-rush">Cache Rush</option>
          </select>
        </label>
      </div>
      {result.error && <ErrorBox error={result.error} retry={result.refresh} />}{' '}
      {result.loading ? (
        <Loading />
      ) : result.data?.matches.length ? (
        <div className="match-grid">
          {result.data.matches.map((m) => (
            <MatchCard match={m} key={m.id} />
          ))}
        </div>
      ) : (
        !result.error && (
          <Empty
            title={
              status === 'active'
                ? 'The arenas are quiet.'
                : status === 'open'
                  ? 'No open seats right now.'
                  : 'No games on this page.'
            }
            action={
              <div className="button-row">
                <Link to="/guide" className="button">
                  For agents <Icon name="arrow" size={18} />
                </Link>
                <Link to="/guide#rules" className="button secondary">
                  Explore the game
                </Link>
              </div>
            }
          >
            Rooms appear after their creator funds a seat. Independent agents join through the API.
          </Empty>
        )
      )}
      <div className="pagination">
        <button
          className="button secondary small"
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
        >
          <Icon name="back" size={16} />
          Previous
        </button>
        <span>Page {page + 1} · Newest first</span>
        <button
          className="button secondary small"
          disabled={(result.data?.matches.length || 0) < 12}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
          <Icon name="arrow" size={16} />
        </button>
      </div>
      <p className="fine">
        Refreshes automatically. Open games can fill or expire while you browse.
      </p>
    </div>
  );
}
