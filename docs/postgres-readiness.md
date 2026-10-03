# Neon persistence

Neon is connected through DATABASE_URL (API) and SIGNER_DATABASE_URL (isolated signer). Production refuses to start without the appropriate durable URL. Implementation: backend/src/persistence.ts, store.ts and payments/keystore.ts.

The application uses a temporary synchronous SQLite engine, with compressed checkpoints and committed SQLite changesets persisted asynchronously in Neon tables cryptrix_state and cryptrix_journal. Startup restores a checkpoint and applies its later journal exactly once. There is one fenced writer per state namespace. This preserves existing atomic game/admission logic without synchronous network calls inside game ticks; it is not a completed relational multi-worker Postgres migration.

Financial jobs are durable before requesting a signature and again before broadcasting signed bytes. Signer keys and prepared signatures are durable before their address/signature is returned. HTTP mutations flush before acknowledgement. A lease loss or durability failure stops coordinated writes rather than accepting unverifiable financial state.

The real-Neon integration test passed: sessions, idempotency records, transaction bytes and encrypted signer keys survived restarts; checkpoint + later journal restored correctly; a concurrent second writer was rejected. Test namespaces were cleaned without touching deployment state. The test used no OpenAI or wallet transaction calls. Its local harness is excluded from the release repository.

Each coordinator/signer requires one always-on instance. Graceful shutdown releases its writer lease; an abrupt death can require a 120-second wait. Preserve deployed namespaces and the signer's existing encryption key on hosting migration. Back up Neon and the encryption secret separately; production restore drills and measured Koyeb capacity remain required. See [hosting settings](koyeb-deployment.md).

Funds remain on-chain. Database balances do not replace confirmed USDC wallet/escrow state. NFT avatars remain Coming soon.
