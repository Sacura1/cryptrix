import { Link } from 'react-router-dom';
import { useResource } from '../hooks';
import { transactionUrl } from '../lib/explorer';
import type { Match, MatchTransfers } from '../types';
import { short } from '../types';
import { AgentAvatar } from './AgentAvatar';
import { Usdc } from './Usdc';
import { Icon } from './ui';

export function MatchRewards({ match }: { match: Match }) {
  const transfers = useResource<MatchTransfers>(
    match.mode === 'paid' ? `/matches/${match.id}/transfers` : null,
    undefined,
    10000,
  );
  const payouts = [...(match.payouts ?? [])].sort((a, b) => a.rankGroup - b.rankGroup);
  const settlementUrl = transfers.data?.settlementHash
    ? transactionUrl(transfers.data.chainId, transfers.data.settlementHash)
    : undefined;
  return (
    <section className="match-rewards" aria-label="Game rewards">
      <div className="rewards-heading">
        <h3>Final standings</h3>
        <span>
          {match.mode === 'practice'
            ? 'Practice rewards'
            : match.settlement === 'settled'
              ? 'Result settled'
              : 'Settlement pending'}
        </span>
      </div>
      <div className="reward-labels" aria-hidden="true">
        <span>Place / Agent</span>
        <span>Reward</span>
        <span>Transfer</span>
      </div>
      <ol className="reward-list">
        {payouts.map((payout) => {
          const participant = match.participants.find((p) => p.agentId === payout.agentId);
          const transfer = transfers.data?.payouts.find((p) => p.agentId === payout.agentId);
          const rank = 1 + payouts.filter((p) => p.rankGroup < payout.rankGroup).length;
          const receipts =
            transfer?.receipts.filter((receipt) =>
              transactionUrl(transfers.data?.chainId, receipt.transactionHash),
            ) ?? [];
          return (
            <li className={`reward-row ${rank === 1 ? 'reward-winner' : ''}`} key={payout.agentId}>
              <div className="reward-agent">
                <span className="reward-place">{String(rank).padStart(2, '0')}</span>
                <AgentAvatar
                  agentId={payout.agentId}
                  name={participant?.name ?? short(payout.wallet)}
                />
                <div>
                  <Link to={`/agents/${payout.agentId}`}>
                    {participant?.name ?? short(payout.wallet)}
                  </Link>
                  <small>{short(payout.wallet)}</small>
                </div>
              </div>
              <div className="reward-amount">
                <Usdc simulated={match.mode === 'practice'}>
                  {Number(payout.amount).toLocaleString(undefined, { maximumFractionDigits: 6 })}
                </Usdc>
              </div>
              <div className="reward-transfer">
                {match.mode === 'practice' ? (
                  <span>Simulated</span>
                ) : Number(payout.amount) === 0 ? (
                  <span className="muted">No prize</span>
                ) : receipts.length ? (
                  <>
                    <span className={transfer?.status === 'confirmed' ? 'transfer-confirmed' : ''}>
                      {transfer?.status === 'confirmed' ? 'Transferred' : 'Part transferred'}
                    </span>
                    {receipts.map((receipt, i) => (
                      <a
                        key={receipt.transactionHash}
                        href={transactionUrl(transfers.data?.chainId, receipt.transactionHash)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`View transfer receipt for ${participant?.name ?? short(payout.wallet)}`}
                        title={`${receipt.amount} USDC sent to this wallet; ${receipt.allocatedAmount} USDC matched to this game`}
                      >
                        Receipt{receipts.length > 1 ? ` ${i + 1}` : ''}{' '}
                        <Icon name="arrow" size={13} />
                      </a>
                    ))}
                  </>
                ) : (
                  <span>
                    {transfers.error
                      ? 'Receipt unavailable'
                      : transfers.loading
                        ? 'Checking receipt…'
                        : transfer?.status === 'settlement-pending' ||
                            match.settlement !== 'settled'
                          ? 'Awaiting settlement'
                          : 'Transfer pending'}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {transfers.error && (
        <button className="text-link" onClick={transfers.refresh}>
          Refresh receipts <Icon name="refresh" size={14} />
        </button>
      )}
      {settlementUrl && (
        <a
          className="text-link reward-settlement"
          href={settlementUrl}
          target="_blank"
          rel="noreferrer"
        >
          View settlement <Icon name="arrow" size={14} />
        </a>
      )}
      {match.mode === 'paid' && (
        <details className="reward-receipt-note">
          <summary>About transfer receipts</summary>
          <p>
            Claims can combine winnings and refunds. Receipts are matched to game credits in
            settlement order; each receipt confirms funds sent to the agent wallet.
          </p>
        </details>
      )}
    </section>
  );
}
