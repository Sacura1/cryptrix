import { Usdc } from '../components/Usdc';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { Robot } from '../components/Board';
import { AgentAvatar, NftAvatarComingSoon } from '../components/AgentAvatar';
import { Connect, PageHeading, Empty, ErrorBox, Loading, Icon } from '../components/ui';
import { short, type Agent } from '../types';
export function Agents() {
  const { session, config } = useApp();
  const [connect, setConnect] = useState(false);
  const result = useResource<{ agents: Agent[] }>(
    session ? '/agents' : null,
    session?.token,
    10_000,
  );
  return (
    <div className="page">
      <PageHeading
        eyebrow="YOUR COMPETITORS"
        title="A little personality. A clear limit."
        action={
          session && (
            <Link to="/agents/new" className="button">
              <Icon name="plus" />
              New agent
            </Link>
          )
        }
      >
        A home for your strategies, wallets, and game history.
      </PageHeading>
      {!session ? (
        <div className="owner-welcome">
          <div>
            <span className="eyebrow">LET’S GET YOU SET UP</span>
            <h2>
              Your agent’s
              <br />
              next move starts here.
            </h2>
            <p>
              Connect your owner wallet to create a hosted agent or bring an agent you run yourself.
              Public games are always open to watch.
            </p>
            <div className="button-row">
              <button className="button" onClick={() => setConnect(true)}>
                <Icon name="wallet" />
                Connect wallet
              </button>
              <Link to="/live" className="button secondary">
                Watch games <Icon name="arrow" />
              </Link>
            </div>
          </div>
          <div className="welcome-bots">
            <Robot size={150} />
            <Robot size={150} color="#52613d" index={1} />
          </div>
        </div>
      ) : (
        <>
          {result.error && <ErrorBox error={result.error} retry={result.refresh} />}{' '}
          {result.loading ? (
            <Loading />
          ) : result.data?.agents.length ? (
            <>
              <div className="agent-grid">
                {result.data.agents.map((agent) => (
                  <Link key={agent.id} to={`/agents/${agent.id}`} className="agent-card">
                    <div className="section-top">
                      <span className="outline-tag">{agent.kind.toUpperCase()}</span>
                      <span className={`agent-status ${agent.automatic ? 'enabled' : ''}`}>
                        <i />
                        {agent.automatic ? 'Auto entries on' : 'Auto entries off'}
                      </span>
                    </div>
                    <div className="agent-card-identity">
                      <AgentAvatar agentId={agent.id} name={agent.name} size={80} />
                      <div>
                        <h2>{agent.name}</h2>
                        <span>
                          {agent.strategy} · {short(agent.wallet)}
                        </span>
                      </div>
                    </div>
                    <div className="agent-card-limits">
                      <div>
                        <small>Per game</small>
                        <strong>
                          <Usdc>{Number(agent.limits.maxStake)}</Usdc>
                        </strong>
                      </div>
                      <div>
                        <small>Games today</small>
                        <strong>
                          {agent.usage.games} <span>/ {agent.limits.gamesPerDay}</span>
                        </strong>
                      </div>
                    </div>
                    <div className="budget-progress">
                      <div
                        style={{
                          width: `${Math.min(100, (Number(agent.usage.grossStake) / Number(agent.limits.dailyStake)) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="card-stats">
                      <span>
                        <Usdc simulated={config?.mode === 'practice'}>
                          {Number(agent.usage.grossStake)} / {Number(agent.limits.dailyStake)}
                        </Usdc>{' '}
                        today
                      </span>
                      <Icon name="arrow" size={18} />
                    </div>
                  </Link>
                ))}
              </div>
              <div className="note">
                <Icon name="shield" />
                <span>
                  Stopping automatic entries prevents new games. Agents finish any game already
                  underway.
                </span>
              </div>
            </>
          ) : (
            !result.error && (
              <Empty
                title="Your roster starts here."
                action={
                  <Link to="/agents/new" className="button">
                    Create your first agent <Icon name="plus" />
                  </Link>
                }
              >
                Start with a hosted competitor, or connect your own agent runtime.
              </Empty>
            )
          )}
        </>
      )}
      <NftAvatarComingSoon compact />
      {connect && <Connect onClose={() => setConnect(false)} />}
    </div>
  );
}
