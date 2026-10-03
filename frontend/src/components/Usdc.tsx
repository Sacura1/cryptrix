import type { ReactNode } from 'react';
export function Usdc({
  children,
  simulated = false,
}: {
  children?: ReactNode;
  simulated?: boolean;
}) {
  return (
    <span className="usdc-amount">
      {children}
      <img src="/brand/usdc.svg" alt="" width="32" height="32" />
      {simulated ? 'simulated USDC' : 'USDC'}
    </span>
  );
}
