import { useApp } from '../context';
import { Usdc } from './Usdc';
import type { Game, Limits, Strategy } from '../types';
export function BehaviorFields({
  name,
  setName,
  strategy,
  setStrategy,
  instructions,
  setInstructions,
}: {
  name?: string;
  setName?: (v: string) => void;
  strategy: Strategy;
  setStrategy: (v: Strategy) => void;
  instructions: string;
  setInstructions: (v: string) => void;
}) {
  return (
    <>
      {setName && (
        <label>
          Agent name
          <input
            value={name}
            maxLength={40}
            placeholder="e.g. Ember"
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
      )}
      <fieldset>
        <legend>Starting strategy</legend>
        <div className="strategy-options">
          {(
            [
              ['aggressive', 'Pressure', 'Commit early. Hunt the advantage.'],
              ['defensive', 'Patience', 'Preserve resources. Choose your moment.'],
              ['explorer', 'Discovery', 'Gather information. Adapt as you go.'],
            ] as const
          ).map(([value, title, text]) => (
            <label
              key={value}
              className={`strategy-choice ${strategy === value ? 'selected' : ''}`}
            >
              <input
                type="radio"
                name="strategy"
                value={value}
                checked={strategy === value}
                onChange={() => setStrategy(value)}
              />
              <strong>{title}</strong>
              <small>{text}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Strategy notes <span className="optional">Optional</span>
        <textarea
          value={instructions}
          maxLength={2000}
          rows={4}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should your agent prioritize? Give it a distinct approach."
        />
        <small>{instructions.length}/2000 · Give your miner a distinct approach.</small>
      </label>
    </>
  );
}
export function LimitFields({
  limits,
  setLimits,
  hosted,
}: {
  limits: Limits;
  setLimits: (v: Limits) => void;
  hosted: boolean;
}) {
  const { config } = useApp();
  const gameCap = hosted ? (config?.hostedTier?.gamesPerDay ?? 10) : (config?.gamesPerDay ?? 10);
  function set<K extends keyof Limits>(key: K, value: Limits[K]) {
    setLimits({ ...limits, [key]: value });
  }
  return (
    <>
      <div className="form-grid">
        <label>
          Max stake per game <Usdc />
          <input
            inputMode="decimal"
            value={limits.maxStake}
            onChange={(e) => set('maxStake', e.target.value)}
            required
          />
          <small>
            0.1–10 <Usdc />. Cache Rush: 1.
          </small>
        </label>
        <label>
          Daily stake budget <Usdc />
          <input
            inputMode="decimal"
            value={limits.dailyStake}
            onChange={(e) => set('dailyStake', e.target.value)}
            required
          />
          <small>Spent stakes count even after a win.</small>
        </label>
        <label>
          Games per day
          <input
            type="number"
            min="1"
            max={gameCap}
            value={limits.gamesPerDay}
            onChange={(e) => set('gamesPerDay', Number(e.target.value))}
            required
          />
          <small>Up to {gameCap} games. Resets at 00:00 UTC.</small>
        </label>
        <label>
          Permission expiry
          <input
            type="datetime-local"
            value={limits.expiresAt ? localDate(limits.expiresAt) : ''}
            onChange={(e) => set('expiresAt', new Date(e.target.value).getTime())}
            required
          />
          <small>Within 30 days. Expiry stops future entries.</small>
        </label>
      </div>
      <fieldset>
        <legend>Allowed games</legend>
        <div className="game-checkboxes">
          {(['flux-duel', 'cache-rush'] as Game[]).map((game) => (
            <label key={game}>
              <input
                type="checkbox"
                disabled={game === 'flux-duel'}
                checked={limits.allowedGames.includes(game)}
                onChange={(e) =>
                  set(
                    'allowedGames',
                    e.target.checked
                      ? [...limits.allowedGames, game]
                      : limits.allowedGames.filter((g) => g !== game),
                  )
                }
              />
              {game === 'flux-duel' ? (
                'Flux Duel · Coming soon'
              ) : (
                <>
                  Cache Rush · <Usdc>1</Usdc>
                </>
              )}
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}
export function localDate(ms: number) {
  const date = new Date(ms);
  return new Date(ms - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
