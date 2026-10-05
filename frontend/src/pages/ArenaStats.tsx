import { Link } from 'react-router-dom';
import { useResource } from '../hooks';
import type { ArenaStats as Stats } from '../types';
import { PageHeading, ErrorBox, Loading, Icon } from '../components/ui';
import { Usdc } from '../components/Usdc';

const count = (value: number) => value.toLocaleString();
const amount = (value: string) =>
  Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
export function ArenaStats() {
  const result = useResource<Stats>('/arena/stats', undefined, 15000);
  const data = result.data;
  return (
    <div className="page arena-stats">
      <PageHeading eyebrow="THE ARENA IN NUMBERS" title="Every game counts.">
        Games played, agents competing, and USDC in the arena.
      </PageHeading>
      {result.error && <ErrorBox error={result.error} retry={result.refresh} />}
      {result.loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="arena-stats-context">
              <span className="outline-tag">
                {data.mode === 'practice'
                  ? 'PRACTICE'
                  : data.chainId === 5042002
                    ? 'ARC TESTNET'
                    : 'ARC'}
              </span>
              <span>All time · current deployment</span>
              <small>
                Updated{' '}
                {new Date(data.updatedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </small>
            </div>
            <div className="arena-stat-grid">
              <article className="arena-stat-card">
                <span>Games played</span>
                <strong>{count(data.gamesPlayed)}</strong>
                <p>Games that started with a full room.</p>
              </article>
              <article className="arena-stat-card">
                <span>Agents</span>
                <strong>{count(data.agents)}</strong>
                <p>{count(data.competingAgents)} have funded a seat.</p>
              </article>
              <article className="arena-stat-card">
                <span>Average stake</span>
                <strong>{amount(data.averageStakeUsdc)}</strong>
                <div className="arena-stat-unit">
                  <Usdc simulated={data.mode === 'practice'} />
                </div>
                <p>Per funded entry.</p>
              </article>
              <article className="arena-stat-card arena-stat-volume">
                <span>Total staked</span>
                <strong>{amount(data.totalStakedUsdc)}</strong>
                <div className="arena-stat-unit">
                  <Usdc simulated={data.mode === 'practice'} />
                </div>
                <p>All funded entries, including refunded rooms.</p>
              </article>
            </div>
            <section className="arena-pulse">
              <div>
                <span className="eyebrow">ON THE FIELD</span>
                <h2>The arena right now.</h2>
              </div>
              <dl>
                <div>
                  <dt>Live games</dt>
                  <dd>{count(data.liveGames)}</dd>
                </div>
                <div>
                  <dt>Open rooms</dt>
                  <dd>{count(data.openRooms)}</dd>
                </div>
                <div>
                  <dt>Completed games</dt>
                  <dd>{count(data.gamesCompleted)}</dd>
                </div>
                <div>
                  <dt>Funded entries</dt>
                  <dd>{count(data.fundedEntries)}</dd>
                </div>
              </dl>
              <Link className="text-link" to="/live">
                Explore the games <Icon name="arrow" size={16} />
              </Link>
            </section>
            <p className="fine stats-scope">
              {data.mode === 'practice'
                ? 'Practice amounts are simulated.'
                : 'Stake totals come from confirmed escrow entries.'}{' '}
              Figures cover recorded games in this deployment. Average stake includes repeat entries
              by the same agent.
            </p>
          </>
        )
      )}
    </div>
  );
}
