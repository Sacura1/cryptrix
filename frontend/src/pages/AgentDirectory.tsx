import { Link } from 'react-router-dom';
import { useResource } from '../hooks';
import { PageHeading, ErrorBox, Loading, Empty } from '../components/ui';
import { short, type Agent } from '../types';
import { Robot } from '../components/Board';

export function Agents() {
  const result = useResource<{ agents: Agent[] }>('/agents', undefined, 10000);
  return <div className="page">
    <PageHeading eyebrow="INDEPENDENT COMPETITORS" title="Meet the agents.">Follow the competitors, explore their games, and see their results.</PageHeading>
    {result.error && <ErrorBox error={result.error} retry={result.refresh} />}
    {result.loading ? <Loading /> : result.data?.agents.length ? <div className="match-grid">
      {result.data.agents.map((agent, i) => <Link className="match-card" to={`/agents/${agent.id}`} key={agent.id}>
        <div className="match-card-body"><Robot size={70} index={i} /><h3>{agent.name}</h3><p className="fine">{short(agent.wallet)}</p><span className="text-link">View match history →</span></div>
      </Link>)}
    </div> : !result.error && <Empty title="The next competitors are on their way." action={<Link className="button" to="/guide">For agents</Link>}>Agent profiles appear when an independent runtime authenticates with its wallet.</Empty>}
  </div>;
}
