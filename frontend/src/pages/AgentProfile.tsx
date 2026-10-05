import { useParams } from 'react-router-dom';
import { useResource } from '../hooks';
import { PageHeading, ErrorBox, Loading, Copy } from '../components/ui';
import { MatchCard } from './Home';
import { useApp } from '../context';
import type { Agent, Match } from '../types';
export function AgentPage() {
  const { id } = useParams(), { config } = useApp();
  const profile = useResource<{ agent: Agent }>(`/agents/${id}`);
  const history = useResource<{ matches: Match[] }>(`/agents/${id}/matches`, undefined, 10000);
  const activity = useResource<{ events: { name: string; transactionHash: string; args: { amount?: string } }[] }>(`/agents/${id}/activity`, undefined, 10000);
  const explorer = config?.chainId === 5042002 ? 'https://explorer.testnet.arc.io' : 'https://explorer.arc.io';
  if (profile.loading) return <Loading />;
  if (profile.error || !profile.data) return <ErrorBox error={profile.error || 'Agent unavailable'} retry={profile.refresh} />;
  const { agent } = profile.data;
  return <div className="page">
    <PageHeading eyebrow="AUTONOMOUS COMPETITOR" title={agent.name}>Independent runtime · Wallet-authenticated participant</PageHeading>
    <p className="fine" style={{ overflowWrap: 'anywhere' }}>{agent.wallet}</p><Copy value={agent.wallet} label="Copy wallet" />
    <section><h2>Match history</h2>{history.error && <ErrorBox error={history.error} retry={history.refresh} />}
      <div className="match-grid">{history.data?.matches.map(match => <MatchCard key={match.id} match={match} />)}</div>
      {history.data && !history.data.matches.length && <p>No matches yet.</p>}
    </section>
    <section><h2>Confirmed transfers</h2>
      {activity.error && <ErrorBox error={activity.error} retry={activity.refresh} />}
      {activity.data?.events.filter(event => event.name === 'CreditClaimed').map(event => <p key={event.transactionHash}>
        {Number(event.args.amount ?? 0) / 1e6} USDC returned to this wallet · <a href={`${explorer}/tx/${event.transactionHash}`} target="_blank" rel="noreferrer">Transaction receipt</a>
      </p>)}<p className="fine">Transfers can combine winnings and refunds from multiple matches.</p>
    </section>
  </div>;
}
