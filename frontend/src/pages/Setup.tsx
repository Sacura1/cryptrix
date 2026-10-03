import { Usdc } from '../components/Usdc';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isAddress } from 'viem';
import { useApp } from '../context';
import { api, amount, message } from '../lib/api';
import { BehaviorFields, LimitFields } from '../components/AgentForm';
import { Robot } from '../components/Board';
import { NftAvatarComingSoon } from '../components/AgentAvatar';
import {
  Connect,
  PageHeading,
  ErrorBox,
  Icon,
  Copy,
  TransactionReview,
  Modal,
} from '../components/ui';
import { short, gameName, type Agent, type Limits, type Plan, type Strategy } from '../types';
export function Setup() {
  const { session, config } = useApp();
  const navigate = useNavigate();
  const [connect, setConnect] = useState(false),
    [step, setStep] = useState(0),
    [kind, setKind] = useState<'hosted' | 'external'>('hosted'),
    [name, setName] = useState(''),
    [strategy, setStrategy] = useState<Strategy>('explorer'),
    [instructions, setInstructions] = useState('');
  const [limits, setLimits] = useState<Limits>({
    maxStake: '1',
    dailyStake: '10',
    gamesPerDay: 10,
    allowedGames: ['cache-rush'],
    expiresAt: Date.now() + 7 * 86400000,
  });
  const [wallet, setWallet] = useState('');
  const stepPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (step === 0 || !stepPanel.current) return;
    stepPanel.current.scrollIntoView({ block: 'start', behavior: 'instant' });
    stepPanel.current.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [step]);
  const [challenge, setChallenge] = useState<{ challengeId: string; message: string }>();
  const [signature, setSignature] = useState('');
  const [account, setAccount] = useState(''),
    [plan, setPlan] = useState<Plan>();
  const [accountReady, setAccountReady] = useState(false);
  const [created, setCreated] = useState<{ agent: Agent; runtimeToken: string }>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const paid = config?.mode === 'paid';
  function next() {
    setError('');
    try {
      if (step === 1 && !name.trim()) throw new Error('Give your agent a name.');
      if (step === 2) {
        amount(limits.maxStake);
        amount(limits.dailyStake, '0.1', '1000');
        if (!limits.allowedGames.length) throw new Error('Allow at least one game.');
        if (
          !Number.isInteger(limits.gamesPerDay) ||
          limits.gamesPerDay < 1 ||
          limits.gamesPerDay >
            (kind === 'hosted'
              ? (config?.hostedTier?.gamesPerDay ?? 10)
              : (config?.gamesPerDay ?? 10))
        )
          throw new Error('Choose a daily game limit within your tier.');
        if (
          !limits.expiresAt ||
          limits.expiresAt <= Date.now() ||
          limits.expiresAt > Date.now() + 30 * 86400000
        )
          throw new Error('Choose an expiry within the next 30 days.');
      }
      setStep((s) => s + 1);
    } catch (e) {
      setError(message(e));
    }
  }
  async function prepareAccount() {
    setBusy(true);
    setError('');
    try {
      if (!session) throw new Error('Connect your owner wallet first.');
      const saltKey = `cryptrix:account-salt:${config?.chainId}:${session.owner}`;
      let salt = localStorage.getItem(saltKey);
      if (!salt) {
        salt = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, '0')).join('')}`;
        localStorage.setItem(saltKey, salt);
      }
      const result = await api<Plan>('/wallets/agent-account/plan', session.token, { salt });
      setAccount(result.account!);
      setAccountReady(!!result.alreadyCreated);
      if (!result.alreadyCreated) setPlan(result);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function linkChallenge() {
    setBusy(true);
    setError('');
    try {
      if (!isAddress(wallet)) throw new Error('Enter a valid agent wallet address.');
      setChallenge(await api('/wallets/link-challenge', session?.token, { wallet }));
      setSignature('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError('');
    try {
      if (!session || !config)
        throw new Error('Connect your owner wallet and wait for the platform configuration.');
      const externalWallet = wallet || session.owner;
      if (kind === 'external' && !isAddress(externalWallet))
        throw new Error('Enter a valid agent wallet address.');
      const other =
        kind === 'external' && externalWallet.toLowerCase() !== session.owner.toLowerCase();
      if (other && (!challenge || !/^0x[\da-fA-F]+$/.test(signature)))
        throw new Error('Prove control of your external agent wallet with a signed challenge.');
      if (kind === 'hosted' && paid && !accountReady)
        throw new Error('Create the owner-controlled agent account first.');
      const result = await api<{ agent: Agent; runtimeToken: string }>('/agents', session.token, {
        name,
        kind,
        strategy,
        instructions,
        limits,
        ...(kind === 'external' ? { wallet: externalWallet } : paid ? { wallet: account } : {}),
        ...(other ? { walletProof: { challengeId: challenge!.challengeId, signature } } : {}),
      });
      setCreated(result);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page setup-page">
      <PageHeading eyebrow="A NEW CONTENDER" title="Make it yours.">
        A few choices now. A strategy you can tune as it plays.
      </PageHeading>
      {!session ? (
        <div className="setup-connect">
          <Robot size={100} />
          <h2>Start with your owner wallet.</h2>
          <p>
            Your wallet signs you in and owns your hosted agent account. No private keys are shared.
          </p>
          <button className="button" onClick={() => setConnect(true)}>
            Connect wallet <Icon name="wallet" />
          </button>
          <Link to="/guide#wallets" className="text-link">
            Understand wallet ownership <Icon name="arrow" size={16} />
          </Link>
        </div>
      ) : (
        <div className="setup-layout">
          <aside className="setup-steps">
            {[
              'Choose your agent',
              'Give it a strategy',
              'Set its boundaries',
              'Review & create',
            ].map((text, i) => (
              <div
                key={text}
                className={`${step === i ? 'current' : ''} ${step > i ? 'done' : ''}`}
              >
                <span>{step > i ? <Icon name="check" size={16} /> : i + 1}</span>
                <div>
                  <strong>{text}</strong>
                  <small>
                    {
                      [
                        'Hosted or your own runtime',
                        'Name, style, and notes',
                        'Games, budget, and expiry',
                        'Owner-controlled wallet',
                      ][i]
                    }
                  </small>
                </div>
              </div>
            ))}
            <div className="setup-trust">
              <Icon name="shield" />
              <p>
                Your funds stay under your owner wallet’s control. Agent spending uses explicit,
                bounded permissions.
              </p>
            </div>
          </aside>
          <section className="setup-card" ref={stepPanel}>
            <span className="eyebrow">STEP {step + 1} OF 4</span>
            <h2 tabIndex={-1}>
              {
                [
                  'Choose your agent.',
                  'Give it a little character.',
                  'Draw the boundaries.',
                  'Ready for the arena?',
                ][step]
              }
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (step < 3) next();
                else void create();
              }}
            >
              {step === 0 && (
                <>
                  <div className="kind-options">
                    <button
                      type="button"
                      className={`kind-card ${kind === 'hosted' ? 'selected' : ''}`}
                      aria-pressed={kind === 'hosted'}
                      onClick={() => {
                        setKind('hosted');
                        setLimits((v) => ({
                          ...v,
                          gamesPerDay: Math.min(
                            v.gamesPerDay,
                            config?.hostedTier?.gamesPerDay ?? 10,
                          ),
                        }));
                      }}
                    >
                      <Robot size={80} />
                      <span className="outline-tag">EASIEST START</span>
                      <h3>Create a hosted agent</h3>
                      <p>We run the decisions. You own the wallet and set the limits.</p>
                      <small>
                        1 hosted agent · up to {config?.hostedTier?.gamesPerDay ?? 10} games/day
                        <br />
                        Runs automatically within your limits
                      </small>
                      <span className="selection-dot" />
                    </button>
                    <button
                      type="button"
                      className={`kind-card ${kind === 'external' ? 'selected' : ''}`}
                      aria-pressed={kind === 'external'}
                      onClick={() => setKind('external')}
                    >
                      <Robot size={80} color="#52613d" index={1} />
                      <span className="outline-tag">YOUR OWN RUNTIME</span>
                      <h3>Bring your agent</h3>
                      <p>You run its brain and wallet. Connect to our game API.</p>
                      <small>
                        Your keys stay in your runtime.
                        <br />
                        One API token per agent.
                      </small>
                      <span className="selection-dot" />
                    </button>
                  </div>
                  {config?.mode === 'practice' && (
                    <p className="note">
                      This environment runs practice games. Hosted agents use local strategy bots
                      unless a model provider is configured.
                    </p>
                  )}
                </>
              )}
              {step === 1 && (
                <>
                  <BehaviorFields
                    name={name}
                    setName={setName}
                    strategy={strategy}
                    setStrategy={setStrategy}
                    instructions={instructions}
                    setInstructions={setInstructions}
                  />
                  <NftAvatarComingSoon name={name || 'Your agent'} compact />
                </>
              )}{' '}
              {step === 2 && (
                <>
                  <LimitFields limits={limits} setLimits={setLimits} hosted={kind === 'hosted'} />
                  <p className="note">
                    These limits stop new entries. Active matches finish normally. Daily budgets
                    count gross stakes; rewards do not reset them.
                  </p>
                </>
              )}
              {step === 3 && (
                <>
                  <div className="review-identity">
                    <Robot size={70} color={kind === 'hosted' ? '#c34a2d' : '#52613d'} />
                    <div>
                      <h3>{name}</h3>
                      <p>
                        {kind} · {strategy}
                      </p>
                    </div>
                  </div>
                  <dl className="review-limits">
                    <div>
                      <dt>Per game</dt>
                      <dd>
                        <Usdc>{limits.maxStake}</Usdc>
                      </dd>
                    </div>
                    <div>
                      <dt>Daily budget</dt>
                      <dd>
                        <Usdc>{limits.dailyStake}</Usdc>
                      </dd>
                    </div>
                    <div>
                      <dt>Games per day</dt>
                      <dd>{limits.gamesPerDay}</dd>
                    </div>
                    <div>
                      <dt>Allowed games</dt>
                      <dd>{limits.allowedGames.map(gameName).join(', ')}</dd>
                    </div>
                    <div>
                      <dt>Permissions expire</dt>
                      <dd>{new Date(limits.expiresAt!).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Automatic entries</dt>
                      <dd>Off until you enable them</dd>
                    </div>
                  </dl>
                  {kind === 'external' && (
                    <>
                      <label>
                        Agent wallet address
                        <input
                          placeholder={session.owner}
                          value={wallet}
                          onChange={(e) => {
                            setWallet(e.target.value);
                            setChallenge(undefined);
                            setSignature('');
                          }}
                        />
                        <small>
                          Leave empty to use your connected owner address. A different wallet must
                          sign a linking challenge.
                        </small>
                      </label>
                      {wallet && wallet.toLowerCase() !== session.owner.toLowerCase() && (
                        <div className="wallet-proof">
                          <button
                            type="button"
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void linkChallenge()}
                          >
                            Get wallet challenge
                          </button>
                          {challenge && (
                            <>
                              <pre>{challenge.message}</pre>
                              <Copy value={challenge.message} label="Copy challenge" />
                              <label>
                                Signature from your agent wallet
                                <textarea
                                  placeholder="0x…"
                                  value={signature}
                                  onChange={(e) => setSignature(e.target.value)}
                                  rows={3}
                                />
                                <small>
                                  Sign this exact message in your own runtime. Do not paste a
                                  private key.
                                </small>
                              </label>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                  {kind === 'hosted' && paid && (
                    <div className="note">
                      <strong>Dedicated owner-controlled account</strong>
                      <p>
                        Create an immutable account owned by {short(session.owner)}. Creating it
                        does not authorize agent spending.
                      </p>
                      {account && <code>{account}</code>}
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || accountReady}
                        onClick={() => void prepareAccount()}
                      >
                        {accountReady
                          ? 'Account confirmed'
                          : busy
                            ? 'Preparing…'
                            : 'Create agent wallet'}
                      </button>
                    </div>
                  )}
                  {!paid && (
                    <p className="note">
                      Practice only. No on-chain wallet is created and no USDC is funded.
                    </p>
                  )}
                  <p className="fine">
                    Next you can fund and authorize a hosted wallet, or connect your external
                    runtime. Automatic entries start off.
                  </p>
                </>
              )}
              {error && <ErrorBox error={error} />}
              <div className="setup-buttons">
                {step > 0 ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => setStep((s) => s - 1)}
                  >
                    <Icon name="back" />
                    Back
                  </button>
                ) : (
                  <Link className="text-link" to="/agents">
                    Back to agents
                  </Link>
                )}
                <button className="button" disabled={busy || !config || !!created}>
                  {busy ? 'Working…' : step < 3 ? 'Continue' : 'Create agent'}
                  <Icon name="arrow" />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {connect && <Connect onClose={() => setConnect(false)} />}{' '}
      {plan && (
        <TransactionReview
          plan={plan}
          onClose={() => setPlan(undefined)}
          onDone={() => {
            setAccountReady(true);
            setPlan(undefined);
          }}
        />
      )}
      {created && (
        <Modal
          title={`${created.agent.name} is ready.`}
          onClose={() => navigate(`/agents/${created.agent.id}`)}
        >
          <div className="success-mark">
            <Icon name="check" size={30} />
          </div>
          <p>
            Automatic entries are off.{' '}
            {kind === 'hosted'
              ? 'Open the agent dashboard to review limits and wallet permissions.'
              : 'Connect your runtime with the API token below.'}
          </p>
          {kind === 'external' && (
            <>
              <p className="fine">
                This token controls this agent’s game API. Keep it private. Wallet signing remains
                separate.
              </p>
              <details>
                <summary>Show one-time runtime token</summary>
                <code className="token">{created.runtimeToken}</code>
                <Copy value={created.runtimeToken} label="Copy runtime token" />
              </details>
            </>
          )}
          <button className="button full" onClick={() => navigate(`/agents/${created.agent.id}`)}>
            Open my agent <Icon name="arrow" />
          </button>
        </Modal>
      )}
    </div>
  );
}
