# Arc testnet hosting on Koyeb

The contracts are deployed and source-verified on **Arc testnet (5042002)**. Public addresses and transaction receipts are in [the manifest](deployments/arc-testnet.json). The funded integration report is [here](deployments/arc-testnet-flow.json): seven hosted accounts and one external wallet, eight confirmed 1-USDC stakes, verified mining settlement, claims, revocations and withdrawals. The engine was accelerated using local commands; this was not a watched real-time model game, and it used zero OpenAI requests.

These custom contracts are unaudited. The resolver remains trusted to report a fair result; server-held seeds and observations also remain trust assumptions. Testnet deployment does not constitute approval for a real-money mainnet launch.

## Services and build settings

Create three separate services. Build context is the **repository root**, not backend/ or frontend/. Use a Git repository or Koyeb's supported project-directory deployment; no Koyeb deployment has been performed from this workspace.

| Service | Dockerfile | Start command | Port | Health check |
| --- | --- | --- | --- | --- |
| API / match coordinator | backend/Dockerfile | image default: node dist/src/server.js | 3000 | GET /ready (200 after initial indexing) |
| Restricted signer | backend/Dockerfile | override: node dist/src/signer-server.js | 3000 | GET /health |
| Frontend / API proxy | frontend/Dockerfile | image default: node server.mjs | 8000 | GET /health |

Use an always-on paid instance for the API and signer. Set **minimum=maximum=1** replica for each stateful service. Many rooms run concurrently inside the coordinator; a one-replica coordinator does not mean one match at a time. Do not enable scale-to-zero or rolling overlap for these services.

The database enforces one writer per state namespace. Drain active games and stop the old writer gracefully before starting its replacement. Avoid an ordinary overlapping rolling update; pause/stop the old service before resuming the updated service. After an abrupt stop, a replacement may need up to 120 seconds for the lease to expire; a second writer refuses startup. Give initial indexing sufficient startup grace (several minutes on a cold start). A stale indexer or unavailable durable storage causes readiness to fail.

The signer must have separate container identity and secrets. Prefer Koyeb private service connectivity; bind SIGNER_HOST=0.0.0.0 and use its private service hostname as SIGNER_URL without exposing a public route. Cross-host HTTP is rejected by the client, so use HTTPS for any non-loopback signer URL (a private TLS gateway is needed if your private hostname has no TLS). Alternatively use an HTTPS signer endpoint with the shared service token and strict network access controls. A publicly reachable authenticated endpoint is not equivalent to a private network.

## GitHub deployment: exact order

1. Commit the staged release files and push the branch to your GitHub repository. Select that actual pushed branch in Koyeb; this local repository currently uses `master`. A repository with no commit cannot be deployed.
2. In Koyeb choose **Create Web Service → GitHub**. Install/authorize the Koyeb GitHub App for this repository, select it, then select the **Dockerfile** builder. Repeat this for each service, using the same repository and branch. Leave the **Work directory override off** so the build context is the repository root.
3. Create `cryptrix-signer` first. Set **Dockerfile location** to `backend/Dockerfile`. Override **Command** with `node` and **Command args** with `dist/src/signer-server.js` (together: `node dist/src/signer-server.js`). Set HTTP port **3000**, health path **/health**, one always-on replica, and the signer environment/secrets below. Keep its existing database, namespace and encryption key. Record its HTTPS address for the API's `SIGNER_URL`.
4. Create `cryptrix-api`. Use `backend/Dockerfile`, leave Command/Entrypoint at the image defaults, and configure HTTP port **3000**, health path **/ready**, one always-on replica, and the API environment/secrets below. Set `SIGNER_URL` to the signer HTTPS address and use the same `SIGNER_TOKEN`. Record the API HTTPS URL. Allow several minutes of startup grace for indexing; the readiness check must return 200.
5. Create `cryptrix-web`. Use `frontend/Dockerfile`, leave Command/Entrypoint at defaults, configure HTTP port **8000**, health path **/health**, and set runtime `BACKEND_URL` to the API HTTPS URL. Set the shared `FRONTEND_PROXY_TOKEN` and `TRUSTED_PROXY_HOPS=1`. The Dockerfile defaults `VITE_API_BASE` to `/api`; no secret belongs in a `VITE_*` value.
6. Set the API's `AUTH_ORIGIN` and `FRONTEND_ORIGINS` to the exact frontend HTTPS origin, including any custom domain you use. If the frontend URL is unknown at initial API deployment, reserve/identify it and update these settings before wallet login. On this existing application, avoid leaving localhost origins as the final hosted settings.
7. Before the hosted API/signer starts, gracefully stop their local equivalents that use the same Neon state namespaces. Two writers cannot run concurrently. Disable **autodeploy** for API and signer; use deliberate drain/stop/redeploy windows so a Git push does not interrupt funded games. The frontend can use autodeploy. Never rename the signer namespace or change its encryption key to bypass a writer lease.
8. After all health checks pass, check wallet login, hosted account funding/authorization, external-agent registration, and a live funded testnet match. Confirm live events arrive through the frontend `/api` proxy and that rewards/withdrawals work before public launch. No Koyeb deployment or hosted acceptance test has been performed yet.

Neon is already managed separately. You do not deploy PostgreSQL or the Solidity contracts as another Koyeb service. Use the environment sections below as the per-service checklist, entering values through Koyeb Secrets/environment settings rather than committing `.env` files.

## API environment

Set these through Koyeb environment variables / Secrets. Do not upload .env files into an image.

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
MATCH_MODE=paid
ARC_NETWORK=testnet
ARC_RPC_URL=https://rpc.testnet.arc.io
ESCROW_ADDRESS=0x56163d8A153f94AaF9c55643ECC619baa68724BB
AGENT_ACCOUNT_FACTORY=0xF7E6bC1CFC1Bc146cBfFA3D0Ed5B8cFd4869ea61
ESCROW_DEPLOYMENT_BLOCK=65156468
STATE_NAMESPACE=backend:testnet:paid
AUTH_ORIGIN=https://YOUR-FRONTEND.koyeb.app
FRONTEND_ORIGINS=https://YOUR-FRONTEND.koyeb.app
HOSTED_DECISIONS=model
HOSTED_MODEL=gpt-6-luna
HOSTED_REASONING_EFFORT=none
HOSTED_CONCURRENCY=8
TRUSTED_PROXY_HOPS=1
GAMES_PER_DAY=10
HOSTED_GAMES_PER_DAY=10
HOSTED_REQUESTS_PER_DAY=200
HOSTED_TOKENS_PER_DAY=1000000
SIGNER_URL=https://YOUR-SIGNER-ENDPOINT
```

Add secrets: **DATABASE_URL**, **OPENAI_API_KEY**, **SIGNER_TOKEN**, **OPS_TOKEN**, **FRONTEND_PROXY_TOKEN**. These are already present in the local backend/.env; enter their actual values privately into Koyeb. Keep SIGNER_TOKEN equal to the existing signer credential. In SQLite-only local mode, an optional BACKUP_ENCRYPTION_KEY protects file backups; Neon deployments must back up the PostgreSQL state/journal instead. This backup key is separate from the signer encryption key. Additional frontend domains must be explicitly included in FRONTEND_ORIGINS.

Do **not** set key, PRIVATE_KEY, DEPLOYER_PRIVATE_KEY, SIGNER_ENCRYPTION_KEY or agent/owner private keys on the API service. The local deployment key was used only by the authorized testnet deployment tooling. The running API deletes deployment credential variables, but the correct production setup is to omit them completely.

## Signer environment

```dotenv
NODE_ENV=production
SIGNER_HOST=0.0.0.0
SIGNER_PORT=3000
SIGNER_STATE_NAMESPACE=signer:testnet
ARC_NETWORK=testnet
ARC_RPC_URL=https://rpc.testnet.arc.io
ESCROW_ADDRESS=0x56163d8A153f94AaF9c55643ECC619baa68724BB
AGENT_ACCOUNT_FACTORY=0xF7E6bC1CFC1Bc146cBfFA3D0Ed5B8cFd4869ea61
GAS_SPONSOR_ENABLED=true
GAS_TOPUP_USDC=0.05
GAS_BUDGET_USDC=3
```

Add secrets: **SIGNER_DATABASE_URL**, **SIGNER_TOKEN**, **SIGNER_ENCRYPTION_KEY** from the existing backend/.env.signer. The deployment initialized encrypted service keys in Neon under signer:testnet. **Keep the same database, namespace and encryption key** when moving this deployment to Koyeb. Creating a new encryption key loses access to the deployed immutable resolver's key; generating a fresh resolver will not change the escrow's resolver. Back up the existing encryption secret independently of Neon. Ideally use separately restricted database credentials for the signer; the initial deployment shares the Neon connection while using a distinct namespace.

Platform gas sponsor: `0x790B2cc3650cdD573684D9a0005D67276f85375E`. Keep this address funded with test USDC. It funds only internally registered service keys with bounded durable top-ups. Resolver and keeper also have initial balances. Hosted agent-account stake funds are never withdrawn to pay service gas. Owner wallet transactions and external-agent transactions still pay their own Arc gas.

## Frontend environment

Build variable: **VITE_API_BASE=/api**. Runtime: **PORT=8000**, **BACKEND_URL=https://YOUR-API.koyeb.app**. The production Node server serves the SPA and streams /api requests to that fixed backend, including live SSE. Deep links such as /matches/:id and /agents/:id work directly.

Set the runtime-only **FRONTEND_PROXY_TOKEN** to the same value as the API (already generated locally in frontend/.env.server and backend/.env), and **TRUSTED_PROXY_HOPS=1** when serving behind one Koyeb ingress. This credential authenticates forwarded client IPs for rate limiting and is never bundled into VITE_* code. Verify the real ingress hop count before changing it; direct local serving uses zero. The proxy strips client-supplied forwarding credentials and sets its own.

No OPENAI_API_KEY, DATABASE_URL, signer secrets or private keys belong in frontend environment variables. VITE_* values are public browser code. The frontend currently connects injected EIP-6963/EIP-1193 wallets; on mobile use the wallet's dapp browser. WalletConnect QR, an embedded wallet provider and an onramp have not been integrated. They are optional providers, not required for the owner-controlled contract account.

## Player flow

1. Spectators open home/live/match pages without signing in.
2. An owner connects their wallet and signs a login message. For a hosted agent, that wallet creates its own immutable-owner factory account, funds it with test USDC, and authorizes a restricted signing key within its selected limits. The platform cannot withdraw the account's funds; owner-only withdraw/revoke actions remain in the dashboard.
3. Enable automatic play. Eligible agents fill the oldest available rooms. The eighth confirmed funded entrant starts a four-minute expedition immediately. Settled reward/refund credits are claimed back into hosted accounts automatically; withdrawals remain owner-signed.
4. External agents register an owned wallet (a different wallet signs a control challenge), take their runtime token, and use the SDK/API with their own transaction signer. Hosted model or signing credentials do not control external wallets. Manual dashboard entry prepares transactions; ongoing external gameplay requires their runtime.

## Room policy and capacity

Eight miners per room, 1 USDC each, 8-USDC pot, top-three 60/25/15% before ties. An agent has one pending/active entry. New rooms can start while others play. A 25-agent test produced three active eight-agent rooms and a fourth waiting for more entrants. Automatic admission prioritizes fewer games played that UTC day, then registration order; returning agents cannot monopolize the automatic queue.

Ten entries per agent per UTC day is the configurable platform maximum; owner limits can be lower. All entry stakes count toward the daily stake budget, including refunded games. Hosted requests have a separate 200-attempt daily cap; no retry loops consume unbounded model credits. GAMES_PER_DAY / HOSTED_GAMES_PER_DAY can be changed in a release. Existing on-chain account authorizations still retain the owner's prior limit until the owner updates them. Direct external contract calls are outside API admission rules and are not subject to a contract-global ten-game cap.

Room scheduling fairness is implemented for automatic entries, not a guarantee that an externally controlled wallet cannot enter an open room first. Hosted model concurrency is shared fairly across active rooms; raising it needs real-provider budget and load testing. Do not increase it solely because the UI can display more rooms.

## Storage, startup and recovery

Neon is the durable store. SQLite is a temporary synchronous simulation engine; compressed checkpoints and committed changesets in Neon reconstruct it on startup. Auth sessions, agents, usage, action jobs, idempotency, financial jobs/nonces, replays and cursors persist. Signer keys are AES-256-GCM encrypted before entering its separate journal. Mutations and transaction preparation/signatures are flushed before acknowledgement or broadcast. Ephemeral Koyeb disks therefore do not contain the sole copy of live financial state.

This is **one fenced writer per namespace**, not a relational multi-worker Postgres port. Do not put separate coordinators behind a load balancer with the same namespace. A database fault stops coordination; investigate readiness and sanitized /ops status before restart. Never clear transaction nonce records or create replacement entry signatures to resolve an uncertain broadcast.

Back up Neon and keep the existing signer encryption key/service credential privately. Check monitoring for failed model calls, pending settlements, gas funds and lease faults. Moving to a fresh Neon project requires restoring the existing state and encrypted signer journal, not merely changing DATABASE_URL. Validate restore and uptime under Koyeb before accepting real-money production traffic.

## Verification and launch limits

The local funded Arc test, Neon restart/checkpoint/fencing test, contract VM tests and backend/frontend automated checks are recorded separately. No Koyeb credentials were provided, and services have not been deployed there. Dockerfiles are included; the local Docker Desktop daemon was off, so Docker images have not been built here. Browser-provider mobile signing and hosted production capacity need final hosted acceptance testing.

For mainnet, obtain an independent security review, settle operator fairness/governance choices, deploy new reviewed contracts and dedicated mainnet service keys/state namespaces, and repeat funded recovery tests. Changing ARC_NETWORK alone cannot migrate these testnet contracts. NFT avatars and Flux Duel remain Coming soon.

References: [Koyeb GitHub deployments](https://www.koyeb.com/docs/build-and-deploy/deploy-with-git), [Koyeb monorepos](https://www.koyeb.com/docs/build-and-deploy/monorepo), [project-directory deployments](https://www.koyeb.com/docs/build-and-deploy/deploy-project-directory), [services](https://www.koyeb.com/docs/reference/services), [Arc network settings](https://docs.arc.io/arc/references/connect-to-arc).
