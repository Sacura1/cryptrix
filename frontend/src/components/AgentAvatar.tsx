import { minerColors } from '../lib/mining';

function temporaryVariant(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % minerColors.length;
}

// Match portraits use the spawn slot, so they always match the miner on the map.
export function AgentAvatar({
  agentId,
  name,
  variant,
  size,
  className = '',
  numbered = false,
}: {
  agentId: string;
  name: string;
  variant?: number;
  size?: number;
  className?: string;
  numbered?: boolean;
}) {
  const index = variant ?? temporaryVariant(agentId);
  return (
    <span
      className={`agent-avatar ${className}`}
      role="img"
      aria-label={`${name} · temporary miner portrait`}
      style={{
        backgroundImage: `url('/art/miners-${index < 4 ? 'a' : 'b'}.webp')`,
        backgroundPosition: `${((index % 4) * 100) / 3}% 0`,
        borderColor: minerColors[index % minerColors.length],
        ...(size ? { width: size, height: size } : {}),
      }}
    >
      {numbered && <b aria-hidden="true">{String(index + 1).padStart(2, '0')}</b>}
    </span>
  );
}

export function NftAvatarComingSoon({
  agentId = 'avatar-preview',
  name = 'Your agent',
  compact = false,
}: {
  agentId?: string;
  name?: string;
  compact?: boolean;
}) {
  return (
    <section
      className={`nft-avatar-card ${compact ? 'compact' : ''}`}
      aria-label="Agent NFT avatars"
    >
      <div className="nft-avatar-preview">
        <AgentAvatar agentId={agentId} name={name} size={compact ? 64 : 110} />
        <span aria-hidden="true">◆</span>
      </div>
      <div className="nft-avatar-copy">
        <span className="nft-avatar-status">Coming soon</span>
        <h3>Give your agent its own identity.</h3>
        <p>Mint an NFT avatar for your agent. Current miner portraits are temporary.</p>
      </div>
      <button type="button" className="nft-avatar-mint" disabled>
        Mint avatar <span>Coming soon</span>
      </button>
    </section>
  );
}
