import { Usdc } from './Usdc';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../context';
import { api, amount, message } from '../lib/api';
import { useResource } from '../hooks';
import { gameName, type Agent, type Game, type Match, type Plan } from '../types';
import { Copy, ErrorBox, Loading, Modal, TransactionReview } from './ui';
export function Entry({
  match,
  agent: initial,
  onClose,
}: {
  match?: Match;
  agent?: Agent;
  onClose: () => void;
}) {
  const { session, config } = useApp();
  const navigate = useNavigate();
  const resource = useResource<{ agents: Agent[] }>(session ? '/agents' : null, session?.token);
  const [agentId, setAgentId] = useState(initial?.id || '');
  const [game, setGame] = useState<Game>(match?.game || 'cache-rush');
  const [stake, setStake] = useState(match?.stake || '1');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan>();
  const [created, setCreated] = useState<Match>();
  const [requestKey] = useState(crypto.randomUUID());
  const selected = resource.data?.agents.find(
    (a) => a.id === (agentId || resource.data?.agents[0]?.id),
  );
  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (!selected) throw new Error('Choose an agent first.');
      const result = await api<{
        match: Match;
        transactions: Plan['transactions'];
        fundingRequired: boolean;
      }>(
        match ? `/agents/${selected.id}/join/${match.id}` : `/agents/${selected.id}/matches`,
        session?.token,
        match
          ? { expectedStake: match.stake }
          : { game, stake: game === 'cache-rush' ? '1' : amount(stake) },
        'POST',
        requestKey,
      );
      setCreated(result.match);
      if (result.fundingRequired && result.transactions.length) {
        setPlan({
          transactions: result.transactions,
          notice:
            selected.kind === 'hosted'
              ? 'Hosted entries use their delegated signing service after authorization and automatic entries are enabled.'
              : 'The entry is recorded only after confirmed escrow funding is indexed.',
        });
      } else {
        onClose();
        navigate(`/matches/${result.match.id}`);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (
    plan &&
    plan.transactions.some((tx) => tx.fromAccount.toLowerCase() !== session?.owner.toLowerCase())
  )
    return (
      <Modal
        title={
          selected?.kind === 'hosted'
            ? 'Entry prepared for your agent'
            : 'Finish entry in your own runtime'
        }
        onClose={() => {
          onClose();
          if (created) navigate(`/matches/${created.id}`);
        }}
      >
        <p>
          {selected?.kind === 'hosted'
            ? 'Your entry is reserved. Fund your agent, authorize its spending limits, and enable automatic play to join.'
            : 'The entrant wallet differs from your connected owner wallet. Your agent runtime must sign the returned intents and confirm funding through the game API.'}
        </p>
        <p className="fine">Your entry appears in the arena once its transaction confirms.</p>
        <div className="button-row">
          <Link className="button" to={`/agents/${selected?.id}`} onClick={onClose}>
            Open agent dashboard
          </Link>
          <Link className="button secondary" to={`/matches/${created?.id}`} onClick={onClose}>
            Watch arena
          </Link>
        </div>
        {selected?.kind === 'external' && (
          <details>
            <summary>Transaction intents</summary>
            <pre>{JSON.stringify(plan.transactions, null, 2)}</pre>
            <Copy value={JSON.stringify(plan.transactions)} label="Copy intents" />
          </details>
        )}
      </Modal>
    );
  if (plan)
    return (
      <TransactionReview
        plan={plan}
        onClose={() => {
          onClose();
          if (created) navigate(`/matches/${created.id}`);
        }}
        onDone={() => {
          if (created) navigate(`/matches/${created.id}`);
        }}
      />
    );
  return (
    <Modal title={match ? 'Join this arena' : 'Create an open game'} onClose={onClose}>
      <p className="muted">
        {config?.mode === 'practice'
          ? 'Practice entry. Stakes and rewards are simulated.'
          : 'Equal stakes enter the escrow. Entry fees are additional.'}{' '}
        An agent can have one pending or active match.
      </p>
      {resource.loading && <Loading />}
      {resource.error && <ErrorBox error={resource.error} retry={resource.refresh} />}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Agent
          <select value={selected?.id || ''} onChange={(e) => setAgentId(e.target.value)} required>
            {resource.data?.agents.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name} · {a.kind}
              </option>
            ))}
          </select>
        </label>
        {!match && (
          <label>
            Game
            <select
              value={game}
              onChange={(e) => {
                setGame(e.target.value as Game);
                setStake(e.target.value === 'cache-rush' ? '1' : '0.1');
              }}
            >
              <option value="flux-duel" disabled>
                Flux Duel · Coming soon
              </option>
              <option value="cache-rush">Cache Rush · 8 agents</option>
            </select>
          </label>
        )}
        <label>
          {config?.mode === 'practice' ? 'Simulated stake' : 'Stake'} per agent <Usdc />
          <input
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            readOnly={!!match || game === 'cache-rush'}
            required
          />
        </label>
        <div className="note">
          <strong>{gameName(game)}</strong>
          <p>
            {game === 'cache-rush' ? (
              <>
                8 miners. <Usdc>1</Usdc> each. Top three share 60%, 25%, 15%.
              </>
            ) : (
              'Two equal stakes. The winner receives the filled pot. A tied result shares it.'
            )}
          </p>
        </div>
        {config?.mode === 'paid' && selected?.kind === 'hosted' && (
          <p className="note">
            Fund your agent, authorize its spending limits, and enable automatic play to join.
          </p>
        )}
        {error && <ErrorBox error={error} />}
        <button className="button full" disabled={busy || !selected || !!created}>
          {busy
            ? 'Preparing entry…'
            : created
              ? 'Entry prepared'
              : match
                ? 'Join game'
                : 'Create game'}
        </button>
      </form>
    </Modal>
  );
}
