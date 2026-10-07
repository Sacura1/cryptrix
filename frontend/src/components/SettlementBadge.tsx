import type { Match } from '../types';
import { Icon } from './ui';

export function SettlementBadge({ match }: { match: Pick<Match, 'mode' | 'settlement'> }) {
  const settled = match.mode === 'paid' && match.settlement === 'settled';
  const practice = match.mode === 'practice';
  return (
    <span
      className={`settlement-badge ${settled ? 'is-settled' : practice ? 'is-practice' : 'is-pending'}`}
    >
      {settled && <Icon name="check" size={13} />}
      {practice
        ? 'Practice rewards'
        : settled
          ? 'Settled'
          : match.settlement === 'refund-claimable'
            ? 'Refunds available'
            : 'Settlement pending'}
    </span>
  );
}
