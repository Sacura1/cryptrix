# Backend security boundaries

This is an internal engineering checklist and threat model, not an independent audit or a certification for mainnet.

## Funds and permission invariants

The immutable user owner is the sole authority for account withdrawal and policy changes. There is no platform administrator, upgrade method or arbitrary execution method on the dedicated agent account. Restricted keys can only fund equal-stake games under allowed-game, maximum-stake, UTC gross-budget, game-count and expiry limits. Key rotation, wins and refunds do not restore daily entry budgets. One live account match blocks another. Entry allowances are exact and cleared afterward.

Escrow payouts can only become credits for original entrant accounts. The complete pot is conserved by the fixed ranking/tie rules. Resolution and cancellation cannot repeat. Deadline cancellation is permissionless, and claims return funds to their fixed account. The service's gas budget is separate from user funds.

Runtime tokens grant scoped game API access and never owner wallet controls. Wallet challenges have application/chain/purpose binding, expiry and one-use consumption. Linking a different external wallet requires that wallet's proof. Hosted wallets must belong to the configured factory and authenticated owner. This prevents accidental custody substitution; it does not stop Sybil participation by one person controlling many wallets.

## Hosted authority and game fairness

The platform does control the hosted restricted signing key. It can spend within the policy the owner explicitly grants; it cannot withdraw or take over the account. Noncustodial ownership is not a promise that delegated gameplay is risk-free. The UI must show the authorized stake/day/count/expiry and the independent on-chain revocation action.

The game service holds private actions, map seeds and observations. Hosted models receive scoped observations with no wallet tools. Spectators see a redacted state until completion. Full completed replays allow deterministic reconstruction, commitment checks, rank checks and pot conservation. An independently running signer checks that reconstruction against funded participants before settlement.

The operator can still bias seed selection, fabricate a consistent action history or favor a participant through its private-state access. The immutable resolver is trusted: the contract itself does not verify game execution and a compromised resolver can award the pot dishonestly among entrants. A seed commitment proves consistency after the offer, not unbiased selection. No public claim of trustless resolution, operator blindness or verifiably unbiased randomness is supported by this version.

Paid API equipment commitments include a fresh private 32-byte random salt, preventing enumeration of the small loadout space from the public hash. The salt persists with the entry intent, is checked against funded equipment, and becomes public with the completed replay. Direct custom entrants can supply a matching salted reveal. Legacy unsalted/default commitments remain supported and their gear is not cryptographically secret. The Rush map's high-entropy committed seed stays private until replay, subject to operator trust. Arc `PREVRANDAO` must not be used as game entropy.

## Service failure handling

Financial jobs are immutable, leased and nonce-unique. Signatures are stored before broadcast. Unknown transaction outcomes retain the same bytes. Fee changes, wrong keys, replay mismatches and expired uncertain jobs are surfaced for review. No retry creates an arbitrary transfer or removes a nonce record. Signer encryption and backup keys remain outside the API process in deployment.

Model attempts are charged before network execution. Uncertain attempts are not repeated after restart. Invalid, failed or late output becomes wait or is discarded; deadlines never pause. Agent memory is private and bounded. Provider-account billing controls are still necessary because local scheduling units are not an exact dollar ceiling.

The clock, indexer, model claims and payment leases are persisted, but production persists a fenced changeset/checkpoint journal in Neon, with SQLite as its disposable local simulation engine and a separate encrypted signer namespace. One writer per namespace is required. Readiness and sanitized operations endpoints expose failure states. Network-filesystem databases, horizontal multi-host scaling and fleet-wide inference admission require a reviewed architecture before use.

## Required external evidence

Independent review must cover contracts, signer isolation, owner recovery, secrets/backup controls, replay attestation, nonce recovery, direct-entrant behavior and private data exposure. Arc integration must test actual native USDC behavior, blocked transfers, finality/receipts and fee estimates. Real LLM playtesting must establish useful strategic variation and an affordable latency/token budget. These checks are release gates; local EVM and mocked-provider tests do not substitute for them.
