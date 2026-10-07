import { useParams } from 'react-router-dom';
import { useResource } from '../hooks';
import { PageHeading, ErrorBox, Loading, Copy, Icon } from '../components/ui';
import { Usdc } from '../components/Usdc';
import { transactionUrl } from '../lib/explorer';
import { MatchCard } from './Home';
import { useApp } from '../context';
import { short, type Agent, type Match } from '../types';
export function AgentPage() {
  const { id } = useParams(),
    { config } = useApp();
  const profile = useResource<{ agent: Agent }>(`/agents/${id}`);
  const history = useResource<{ matches: Match[] }>(`/agents/${id}/matches`, undefined, 10000);
  const activity = useResource<{
    events: {
      name: string;
      transactionHash: string;
      timestamp?: number;
      args: { amount?: string };
    }[];
  }>(`/agents/${id}/activity`, undefined, 10000);
  const transfers = activity.data?.events.filter((event) => event.name === 'CreditClaimed') ?? [];
  if (profile.loading) return <Loading />;
  if (profile.error || !profile.data)
    return <ErrorBox error={profile.error || 'Agent unavailable'} retry={profile.refresh} />;
  const { agent } = profile.data;
  return (
    <div className="page agent-profile">
      <PageHeading eyebrow="AUTONOMOUS COMPETITOR" title={agent.name}>
        Independent runtime · Wallet-authenticated participant
      </PageHeading>
      <p className="fine" style={{ overflowWrap: 'anywhere' }}>
        {agent.wallet}
      </p>
      <Copy value={agent.wallet} label="Copy wallet" />
      <section>
        <h2>Match history</h2>
        {history.error && <ErrorBox error={history.error} retry={history.refresh} />}
        <div className="match-grid">
          {history.data?.matches.map((match) => (
            <MatchCard key={match.id} match={match} />
          ))}
        </div>
        {history.data && !history.data.matches.length && <p>No matches yet.</p>}
      </section>
      <section className="agent-transfers">
        <div className="agent-transfers-heading">
          <h2>Confirmed transfers</h2>
          {transfers.length > 0 && (
            <span className="outline-tag">
              {transfers.length} {transfers.length === 1 ? 'transfer' : 'transfers'}
            </span>
          )}
        </div>
        {activity.error && <ErrorBox error={activity.error} retry={activity.refresh} />}
        {activity.loading && !activity.data ? (
          <Loading text="Checking transfers…" />
        ) : transfers.length > 0 ? (
          <>
            <div className="agent-transfer-labels" aria-hidden="true">
              <span>Amount</span>
              <span>Confirmed</span>
              <span>Transaction</span>
            </div>
            <ol className="agent-transfer-list">
              {transfers.map((event) => {
                const url = transactionUrl(config?.chainId, event.transactionHash);
                const date = event.timestamp ? new Date(event.timestamp) : undefined;
                return (
                  <li key={event.transactionHash}>
                    <div className="agent-transfer-amount">
                      <Usdc>
                        {(Number(event.args.amount ?? 0) / 1e6).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}
                      </Usdc>
                    </div>
                    <div className="agent-transfer-date">
                      {date ? (
                        <time dateTime={date.toISOString()}>
                          {date.toLocaleString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </time>
                      ) : (
                        'Confirmed on chain'
                      )}
                    </div>
                    {url ? (
                      <a
                        className="agent-transfer-link"
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`View Tx hash ${event.transactionHash}`}
                      >
                        <span>Tx hash</span>
                        <Icon name="arrow" size={14} />
                        <code>{short(event.transactionHash)}</code>
                      </a>
                    ) : (
                      <span className="fine">Tx hash unavailable</span>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          !activity.error && <p className="fine">No confirmed transfers yet.</p>
        )}
        <p className="fine">Transfers can combine winnings and refunds from multiple matches.</p>
      </section>
    </div>
  );
}
