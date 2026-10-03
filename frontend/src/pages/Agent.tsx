import { Usdc } from '../components/Usdc';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../context';
import { useResource } from '../hooks';
import { api, amount, message, API } from '../lib/api';
import { BehaviorFields, LimitFields } from '../components/AgentForm';
import { Entry } from '../components/Entry';
import { Robot } from '../components/Board';
import { AgentAvatar, NftAvatarComingSoon } from '../components/AgentAvatar';
import { Connect, Copy, ErrorBox, Loading, Icon, Modal, TransactionReview } from '../components/ui';
import {
  gameName,
  short,
  type Agent,
  type Limits,
  type Strategy,
  type Match,
  type Plan,
  type WalletStatus,
} from '../types';
export function AgentPage() {
  const { id } = useParams();
  const { session, config, notify } = useApp();
  const agents = useResource<{ agents: Agent[] }>(
    session ? '/agents' : null,
    session?.token,
    10_000,
  );
  const agent = agents.data?.agents.find((a) => a.id === id);
  const history = useResource<{ matches: Match[] }>(
    session && id ? `/agents/${id}/matches?limit=25` : null,
    session?.token,
    5000,
  );
  const [tab, setTab] = useState('overview'),
    [connect, setConnect] = useState(false),
    [entry, setEntry] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState<string>(),
    [rotate, setRotate] = useState(false);
  async function automatic() {
    setBusy(true);
    setError('');
    try {
      await api(`/agents/${id}/automatic`, session?.token, { enabled: !agent!.automatic });
      agents.refresh();
      notify(
        agent!.automatic
          ? 'Future automatic entries stopped. Active games continue.'
          : 'Automatic entries enabled within your limits.',
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function rotateToken() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ runtimeToken: string }>(
        `/agents/${id}/runtime-token`,
        session?.token,
        {},
      );
      setToken(result.runtimeToken);
      setRotate(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (!session)
    return (
      <div className="page">
        <div className="empty">
          <h1>Your agent dashboard.</h1>
          <p>Sign in with the owner wallet to view this agent.</p>
          <button className="button" onClick={() => setConnect(true)}>
            Connect wallet <Icon name="wallet" />
          </button>
        </div>
        {connect && <Connect onClose={() => setConnect(false)} />}
      </div>
    );
  if (!agent)
    return (
      <div className="page">
        {agents.loading ? (
          <Loading />
        ) : agents.error ? (
          <ErrorBox error={agents.error} retry={agents.refresh} />
        ) : (
          <div className="empty">
            <h2>Agent not found in your roster.</h2>
            <Link to="/agents" className="button secondary">
              Back to my agents
            </Link>
          </div>
        )}
      </div>
    );
  const active = history.data?.matches.find((m) =>
    ['active', 'open', 'funding'].includes(m.status),
  );
  return (
    <div className="page agent-detail">
      <div className="breadcrumb">
        <Link to="/agents">
          <Icon name="back" size={16} />
          My agents
        </Link>
        <span>/</span>
        {agent.name}
      </div>
      <div className="agent-detail-heading">
        <div className="agent-detail-identity">
          <AgentAvatar agentId={agent.id} name={agent.name} size={100} />
          <div>
            <span className="eyebrow">
              {agent.kind.toUpperCase()} AGENT / {config?.mode === 'practice' ? 'PRACTICE' : 'ARC'}
            </span>
            <h1>
              {agent.name}
              <span className="title-dot">.</span>
            </h1>
            <span>
              {short(agent.wallet)} · {agent.strategy}
            </span>
          </div>
        </div>
        <div className="agent-actions">
          <span className={`agent-status ${agent.automatic ? 'enabled' : ''}`}>
            <i />
            {agent.automatic ? 'Automatic entries enabled' : 'Automatic entries stopped'}
          </span>
          <button
            className={`button ${agent.automatic ? 'secondary' : ''}`}
            disabled={busy}
            onClick={() => void automatic()}
          >
            {busy
              ? 'Updating…'
              : agent.automatic
                ? 'Stop automatic entries'
                : 'Enable automatic entries'}
            <Icon name={agent.automatic ? 'shield' : 'play'} size={18} />
          </button>
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      <div className="tabs detail-tabs" role="tablist" aria-label="Agent settings">
        {['overview', 'avatar', 'wallet', 'strategy', 'limits', 'runtime'].map((t) => (
          <button
            role="tab"
            key={t}
            aria-selected={tab === t}
            className={tab === t ? 'selected' : ''}
            onClick={() => {
              setTab(t);
              setError('');
            }}
          >
            {t === 'runtime' ? 'Runtime & API' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === 'avatar' && <NftAvatarComingSoon agentId={agent.id} name={agent.name} />}
      {tab === 'overview' && (
        <>
          <div className="metric-grid">
            <Metric
              title="Games today"
              value={`${agent.usage.games} / ${agent.limits.gamesPerDay}`}
              subtitle="Entries count, including unfinished games"
            />
            <Metric
              title={config?.mode === 'practice' ? 'Simulated gross stake' : 'Gross stake today'}
              value={
                <Usdc simulated={config?.mode === 'practice'}>
                  {Number(agent.usage.grossStake)} / {Number(agent.limits.dailyStake)}
                </Usdc>
              }
              subtitle="Rewards do not reset this budget"
            />
            <Metric
              title="Maximum entry"
              value={<Usdc>{Number(agent.limits.maxStake)}</Usdc>}
              subtitle="Per game"
            />
            <Metric
              title={agent.hostedDecisions === 'model' ? 'Decisions today' : 'Agent control'}
              value={
                agent.hostedDecisions === 'model'
                  ? `${agent.usage.requests ?? 0} / ${config?.hostedTier?.requestsPerDay ?? 200}`
                  : agent.kind === 'external'
                    ? 'Your runtime'
                    : agent.hostedDecisions || '—'
              }
              subtitle={
                agent.hostedDecisions === 'model'
                  ? 'Resets at 00:00 UTC'
                  : agent.kind === 'external'
                    ? 'Decisions run in your own runtime'
                    : 'Follows your chosen strategy'
              }
            />
          </div>
          <div className="overview-columns">
            <section className="panel">
              <div className="section-top">
                <h2>{active ? 'Your current arena' : 'Ready when you are.'}</h2>
                <Icon name="play" />
              </div>
              {active ? (
                <>
                  <span className="outline-tag">{active.status.toUpperCase()}</span>
                  <h3>{gameName(active.game)}</h3>
                  <p>
                    {active.state
                      ? `Round ${active.state.round}/20`
                      : `${active.filled}/${active.capacity} seats`}{' '}
                    · <Usdc simulated={active.mode === 'practice'}>{Number(active.stake)}</Usdc> per
                    agent
                  </p>
                  <Link to={`/matches/${active.id}`} className="button">
                    Open arena <Icon name="arrow" />
                  </Link>
                </>
              ) : (
                <>
                  <p>
                    Browse open games or create an offer. Your agent can join one game at a time.
                  </p>
                  <div className="button-row">
                    <Link to="/live" className="button secondary">
                      Find a game
                    </Link>
                    <button className="button" onClick={() => setEntry(true)}>
                      Create game <Icon name="plus" size={17} />
                    </button>
                  </div>
                </>
              )}
            </section>
            <section className="panel">
              <span className="eyebrow">THE BOUNDARIES</span>
              <h2>You call the limits.</h2>
              <dl>
                <div>
                  <dt>Allowed games</dt>
                  <dd>{agent.limits.allowedGames.map(gameName).join(', ')}</dd>
                </div>
                <div>
                  <dt>Permissions expire</dt>
                  <dd>{new Date(agent.limits.expiresAt!).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt>Daily reset</dt>
                  <dd>
                    {new Date(agent.usage.nextReset).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}{' '}
                    local
                  </dd>
                </div>
              </dl>
              <button className="text-link" onClick={() => setTab('limits')}>
                Edit limits <Icon name="arrow" size={17} />
              </button>
            </section>
          </div>
          <History result={history} />
          <div className="note">
            <Icon name="shield" />
            <span>
              Stopping automatic entries prevents new matches. It cannot pause a game already in
              progress. Expiry and daily budgets also apply to future entries.
            </span>
          </div>
        </>
      )}
      {tab === 'wallet' && <WalletPanel agent={agent} active={active} />}{' '}
      {tab === 'strategy' && <BehaviorPanel agent={agent} onSaved={agents.refresh} />}{' '}
      {tab === 'limits' && <LimitsPanel agent={agent} onSaved={agents.refresh} />}{' '}
      {tab === 'runtime' && (
        <section className="panel runtime-panel">
          <span className="eyebrow">
            {agent.kind === 'hosted' ? 'HOSTED DECISIONS' : 'YOUR OWN RUNTIME'}
          </span>
          <h2>
            {agent.kind === 'hosted'
              ? 'We run the decisions. You own the account.'
              : 'Connect your agent to the arena.'}
          </h2>
          <p>
            {agent.kind === 'hosted'
              ? 'Your agent follows its strategy and spending limits. Its signing key cannot withdraw funds.'
              : 'Your runtime discovers games, submits actions, and signs its own wallet transactions. A runtime token grants game API access; it does not sign wallet transactions.'}
          </p>
          <div className="runtime-endpoint">
            <span>Public API base</span>
            <code>{new URL(API, location.origin).href}</code>
            <Copy value={new URL(API, location.origin).href} />
          </div>
          <pre>{`# Keep the runtime token in your own secret store.\ncurl -H "Authorization: Bearer $CRYPTRIX_AGENT_TOKEN" \\\n  "${new URL(API, location.origin).href}/runtime/me"\n\n# Find open games (public)\ncurl "${new URL(API, location.origin).href}/matches?status=open"`}</pre>
          <div className="button-row">
            <button className="button secondary" onClick={() => setRotate(true)}>
              Rotate runtime token
            </button>
            <Link to="/guide#runtime" className="text-link">
              Integration guide <Icon name="arrow" size={17} />
            </Link>
          </div>
          {agent.kind === 'external' && (
            <p className="fine">Connect your runtime to start playing.</p>
          )}
          {agent.kind === 'hosted' && (
            <div className="note">
              1 hosted agent · up to {config?.hostedTier?.gamesPerDay ?? 10} games/day · one game at
              a time.
            </div>
          )}
        </section>
      )}
      {entry && (
        <Entry
          agent={agent}
          onClose={() => {
            setEntry(false);
            history.refresh();
          }}
        />
      )}
      {rotate && (
        <Modal title="Replace the runtime token?" onClose={() => setRotate(false)}>
          <p>
            The current token stops working immediately. Update any external runtime that uses it.
            Wallet permissions remain separate.
          </p>
          <button className="button" disabled={busy} onClick={() => void rotateToken()}>
            {busy ? 'Rotating…' : 'Replace token'}
          </button>
          {error && <ErrorBox error={error} />}
        </Modal>
      )}
      {token && (
        <Modal title="Save your new runtime token" onClose={() => setToken(undefined)}>
          <p>This token is shown once. Keep it in your runtime’s secret store.</p>
          <details>
            <summary>Reveal token</summary>
            <code className="token">{token}</code>
            <Copy value={token} label="Copy token" />
          </details>
          <button className="button" onClick={() => setToken(undefined)}>
            Done
          </button>
        </Modal>
      )}
    </div>
  );
}
function Metric({ title, value, subtitle }: { title: string; value: ReactNode; subtitle: string }) {
  return (
    <div className="metric">
      <small>{title}</small>
      <strong>{value}</strong>
      <span>{subtitle}</span>
    </div>
  );
}
function History({ result }: { result: ReturnType<typeof useResource<{ matches: Match[] }>> }) {
  return (
    <section className="history-section">
      <div className="section-heading">
        <h2>Recent games</h2>
        <button className="text-link" onClick={result.refresh}>
          Refresh <Icon name="refresh" size={16} />
        </button>
      </div>
      {result.error && <ErrorBox error={result.error} retry={result.refresh} />}{' '}
      {result.loading ? (
        <Loading />
      ) : result.data?.matches.length ? (
        <div className="history-table">
          {result.data.matches.map((m) => (
            <Link key={m.id} to={`/matches/${m.id}`}>
              <span>
                <strong>{gameName(m.game)}</strong>
                <small>{new Date(m.createdAt).toLocaleString()}</small>
              </span>
              <span className="outline-tag">{m.status.toUpperCase()}</span>
              <span>
                <Usdc simulated={m.mode === 'practice'}>{Number(m.stake)}</Usdc>
              </span>
              <Icon name="arrow" size={18} />
            </Link>
          ))}
        </div>
      ) : (
        !result.error && <p className="muted">No games yet. Your first arena will appear here.</p>
      )}
      <p className="fine">Your latest games.</p>
    </section>
  );
}
function BehaviorPanel({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const { session, notify } = useApp();
  const [strategy, setStrategy] = useState<Strategy>(agent.strategy),
    [instructions, setInstructions] = useState(agent.instructions),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="panel settings-panel">
      <span className="eyebrow">PERSONALITY & APPROACH</span>
      <h2>Give it a different angle.</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          void api(
            `/agents/${agent.id}/behavior`,
            session?.token,
            { strategy, instructions },
            'PATCH',
          )
            .then(() => {
              onSaved();
              notify('Strategy saved. Future decisions use the updated settings.');
            })
            .catch((e) => setError(message(e)))
            .finally(() => setBusy(false));
        }}
      >
        <BehaviorFields
          strategy={strategy}
          setStrategy={setStrategy}
          instructions={instructions}
          setInstructions={setInstructions}
        />
        <p className="fine">
          Locked actions cannot be changed. Your external runtime decides how to use these
          preferences.
        </p>
        {error && <ErrorBox error={error} />}
        <button className="button" disabled={busy}>
          {busy ? 'Saving…' : 'Save strategy'}
          <Icon name="check" size={17} />
        </button>
      </form>
    </section>
  );
}
function LimitsPanel({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const { session, config, notify } = useApp();
  const [limits, setLimits] = useState<Limits>(agent.limits),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <section className="panel settings-panel">
      <span className="eyebrow">ENTRY PERMISSIONS</span>
      <h2>Keep the stakes in bounds.</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            amount(limits.maxStake);
            amount(limits.dailyStake, '0.1', '1000');
            void api(`/agents/${agent.id}/limits`, session?.token, limits, 'PATCH')
              .then(() => {
                onSaved();
                notify('Platform limits saved.');
              })
              .catch((e) => setError(message(e)))
              .finally(() => setBusy(false));
          } catch (error) {
            setError(message(error));
            setBusy(false);
          }
        }}
      >
        <LimitFields limits={limits} setLimits={setLimits} hosted={agent.kind === 'hosted'} />
        {config?.mode === 'paid' && agent.kind === 'hosted' && (
          <p className="note">
            Saving platform limits does not change on-chain wallet permissions. Open Wallet and sign
            “Authorize current limits” to update them. The tighter of both sets of limits applies.
          </p>
        )}
        {error && <ErrorBox error={error} />}
        <button className="button" disabled={busy}>
          {busy ? 'Saving…' : 'Save limits'}
          <Icon name="check" size={17} />
        </button>
      </form>
    </section>
  );
}
function WalletPanel({ agent, active }: { agent: Agent; active?: Match }) {
  const { session, config } = useApp();
  const paid = config?.mode === 'paid',
    hosted = agent.kind === 'hosted';
  const status = useResource<WalletStatus>(
    paid && hosted ? `/agents/${agent.id}/wallet` : null,
    session?.token,
    15_000,
  );
  const activity = useResource<{
    events: { eventName?: string; transactionHash?: string; args?: Record<string, unknown> }[];
  }>(paid ? `/agents/${agent.id}/activity` : null, session?.token);
  const [plan, setPlan] = useState<Plan>(),
    [operation, setOperation] = useState<'fund' | 'withdraw'>(),
    [value, setValue] = useState('5'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function prepare(op: string) {
    setBusy(true);
    setError('');
    try {
      let body: Record<string, unknown> = { operation: op };
      if (op === 'fund' || op === 'withdraw') body.amount = amount(value, '0.000001', '1000');
      if (op === 'authorize') {
        const signer = await api<{ address: string }>(`/agents/${agent.id}/signer`, session?.token);
        body.key = signer.address;
      }
      if (op.startsWith('cancel')) body.matchId = active?.id;
      const result = await api<Plan>(`/agents/${agent.id}/wallet/plan`, session?.token, body);
      setOperation(undefined);
      setPlan(result);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel wallet-panel">
        <div className="section-top">
          <div>
            <span className="eyebrow">
              {hosted ? 'OWNER-CONTROLLED ACCOUNT' : 'EXTERNAL AGENT WALLET'}
            </span>
            <h2>Agent wallet</h2>
          </div>
          <Icon name="shield" size={28} />
        </div>
        <div className="address-row">
          <code>{agent.wallet}</code>
          <Copy value={agent.wallet} label="Copy address" />
        </div>
        {!paid ? (
          <div className="practice-wallet">
            <Robot size={75} />
            <div>
              <h3>Practice has no real wallet balance.</h3>
              <p>
                All game amounts are simulated. Funding, withdrawals, and on-chain authorization
                become available in the configured paid environment.
              </p>
            </div>
            <Link className="text-link" to="/guide#wallets">
              How ownership works <Icon name="arrow" size={17} />
            </Link>
          </div>
        ) : !hosted ? (
          <div className="note">
            You control this agent’s wallet and signing in your own runtime. Fund and withdraw
            through that wallet. Cryptrix does not hold its keys.
          </div>
        ) : (
          <>
            {status.loading && <Loading />}
            {status.error && <ErrorBox error={status.error} retry={status.refresh} />}{' '}
            {status.data && (
              <>
                <div className="metric-grid wallet-metrics">
                  <Metric
                    title="Available balance"
                    value={<Usdc>{status.data.balanceUsdc}</Usdc>}
                    subtitle="Excludes escrow credits"
                  />
                  <Metric
                    title="Claimable credits"
                    value={<Usdc>{status.data.claimableUsdc}</Usdc>}
                    subtitle="Returns to the agent account"
                  />
                  <Metric
                    title="Wallet gross stake today"
                    value={<Usdc>{status.data.onChainUsage.grossStake}</Usdc>}
                    subtitle={`${status.data.onChainUsage.games} on-chain entries today`}
                  />
                </div>
                <div className="button-row">
                  <button
                    className="button"
                    onClick={() => {
                      setError('');
                      setOperation('fund');
                    }}
                  >
                    Fund <Usdc /> <Icon name="plus" size={18} />
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setError('');
                      setOperation('withdraw');
                    }}
                  >
                    Withdraw to owner
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy || Number(status.data.claimableUsdc) <= 0}
                    onClick={() => void prepare('claim')}
                  >
                    Claim credits
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Refresh wallet balance"
                    onClick={status.refresh}
                  >
                    <Icon name="refresh" />
                  </button>
                </div>
                <p className="fine">Gas fees are paid separately from your stake.</p>
                <div className="wallet-policy">
                  <h3>Restricted agent permission</h3>
                  <span className="outline-tag">
                    {status.data.policy?.revoked
                      ? 'REVOKED'
                      : status.data.policy?.expiresAt && status.data.policy.expiresAt < Date.now()
                        ? 'EXPIRED'
                        : 'AUTHORIZED'}
                  </span>
                  <dl>
                    <div>
                      <dt>Delegated signer</dt>
                      <dd>{short(status.data.policy?.key)}</dd>
                    </div>
                    <div>
                      <dt>Wallet maximum stake</dt>
                      <dd>
                        <Usdc>{status.data.policy?.maxStake || '0'}</Usdc>
                      </dd>
                    </div>
                    <div>
                      <dt>Wallet daily budget</dt>
                      <dd>
                        <Usdc>{status.data.policy?.dailyStake || '0'}</Usdc>
                      </dd>
                    </div>
                    <div>
                      <dt>Games per day</dt>
                      <dd>{status.data.policy?.gamesPerDay || 0}</dd>
                    </div>
                    <div>
                      <dt>Expiry</dt>
                      <dd>
                        {status.data.policy?.expiresAt
                          ? new Date(status.data.policy.expiresAt).toLocaleString()
                          : 'None'}
                      </dd>
                    </div>
                  </dl>
                  <p>
                    The agent key can enter games under these bounds. It cannot withdraw funds or
                    execute arbitrary calls. Only your owner wallet can change this permission.
                  </p>
                  <div className="button-row">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void prepare('authorize')}
                    >
                      Authorize current limits
                    </button>
                    <button
                      className="text-link danger"
                      disabled={busy}
                      onClick={() => void prepare('revoke')}
                    >
                      Revoke agent permission
                    </button>
                  </div>
                  {active?.refundAvailable && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void prepare(
                          active.status === 'active' ? 'cancel-expired' : 'cancel-unfilled',
                        )
                      }
                    >
                      Request available refund
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
        {error && <ErrorBox error={error} />}
      </section>
      {paid && (
        <section className="panel">
          <h2>Wallet activity</h2>
          {activity.error && <ErrorBox error={activity.error} retry={activity.refresh} />}{' '}
          {activity.loading ? (
            <Loading />
          ) : activity.data?.events.length ? (
            <div className="history-table">
              {activity.data.events.map((event, i) => (
                <div key={i} className="ledger-row">
                  <strong>{event.eventName || 'Escrow activity'}</strong>
                  <code>{short(event.transactionHash)}</code>
                  {event.transactionHash && (
                    <Copy value={event.transactionHash} label="Copy hash" />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">No indexed activity for this wallet yet.</p>
          )}
          <p className="fine">
            Credits are claimed as an aggregate balance. Claims are not assigned to individual
            games.
          </p>
        </section>
      )}
      {operation && (
        <Modal
          title={operation === 'fund' ? 'Fund your agent' : 'Withdraw to your owner wallet'}
          onClose={() => setOperation(undefined)}
        >
          <p>
            {operation === 'fund'
              ? 'Transfer USDC from your owner wallet to this agent account.'
              : 'Withdraw available USDC from the agent account to its immutable owner. Escrow stakes remain locked until settlement or an eligible refund.'}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void prepare(operation);
            }}
          >
            <label>
              Amount <Usdc />
              <input
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
              />
            </label>
            {error && <ErrorBox error={error} />}
            <button className="button full" disabled={busy}>
              {busy ? 'Preparing…' : 'Review transaction'}
              <Icon name="wallet" size={18} />
            </button>
          </form>
        </Modal>
      )}
      {plan && (
        <TransactionReview
          plan={plan}
          onClose={() => {
            setPlan(undefined);
            status.refresh();
            activity.refresh();
          }}
          onDone={() => {
            status.refresh();
            activity.refresh();
          }}
        />
      )}
    </>
  );
}
