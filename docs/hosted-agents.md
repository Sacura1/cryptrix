# Hosted decisions

Cache Rush version 2 uses **independent miner decision sequences**, not a global round. Each hosted miner has at most 20 high-level jobs during the four-minute match. Walking, inspection, pickaxe swings and hazard simulation run in the engine without extra provider calls. The worker only claims a job when that miner is ready; another miner can decide or act independently. Requests, failed calls and fallbacks retain the existing daily accounting and provider limits. Jobs are unique by match, miner and decision sequence, and late results cannot become a future decision.

Rush model observations include only that miner's remembered inspections, its own cargo/treatment status, visible terrain clues, nearby hazards, extraction/treatment stations and public banked scores. The terrain uses a compact row-major encoding to keep prompts bounded. Other miners' notes, private memory, wallet credentials and the unrevealed seed never enter the request. The provider's structured response supports mining job types and optional target coordinates; invalid output falls back to a timed wait. Local practice remains explicitly labelled strategy bots rather than model execution.

The game engine, match clock, model execution and financial signing are separate. A hosted model chooses game actions without wallet tools or owner credentials. Paid entry jobs use a separate restricted signer authorized by the owner on-chain. Its encrypted key storage, durable nonce/signature handling and transaction allowlist are implemented. External agents keep using their own runtimes. See [signer operations](backend-operations.md).

## Configuration

Default `HOSTED_DECISIONS=strategy` runs local practice bots without inference charges. `disabled` runs only the clock and external actions. To use the optional OpenAI adapter, configure `backend/.env`:

```dotenv
HOSTED_DECISIONS=model
HOSTED_MODEL=your-explicit-compatible-model
HOSTED_CONCURRENCY=8
OPENAI_API_KEY=your-service-credential
```

Supply service credentials through a secrets manager in deployment. Model selection is explicit; it must support Responses structured outputs. No default model or price is assumed. Switching to model mode suppresses the built-in bots, preventing two runtimes from deciding the same hosted action. Run `npm run build` and `npm start` from the root after configuration.

For the first Luna game test, use `HOSTED_MODEL=gpt-6-luna` and `HOSTED_REASONING_EFFORT=none`. The optional reasoning setting is passed as Responses `reasoning.effort`; omitting it preserves the provider's model default. Luna defaults to medium reasoning when no effort is supplied, which can consume the 512-token cap before an action JSON completes. Start with none for short decisions, then evaluate low separately if gameplay needs it. No Fast processing tier is requested. See [the current Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna).

Local model-test controls and playtest scripts are excluded from the release repository. Production games are watched through `/live` and `/matches/:id` using public live SSE updates; the production API does not expose test-control endpoints.

The optional adapter follows [Responses creation](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create) and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). It requests strict action JSON and `store:false`, exposes no tools, bounds the response body, and rejects incomplete/refused/malformed output. `store:false` is not a promise of zero provider retention; review the provider's data controls before production. The `DecisionProvider` interface supports other providers without changing the engine or wallet contracts.

## Starter limits

| Control | Limit |
| --- | --- |
| Hosted agents | One per owner |
| Game entries | Owner limit, at most ten per UTC day |
| Model requests | 200 per agent per UTC day, separately for practice and paid |
| Rounds | At most twenty per game |
| Request duration | Twelve seconds, shortened to finish before the round deadline |
| Serialized prompt | 16,384 UTF-8 bytes |
| Generated tokens | 512, including provider reasoning tokens when applicable |
| Response body | 65,536 bytes |
| Owner strategy notes | 2000 characters |
| Agent memory | 1000 characters, private to that agent and match |
| Conservative inference allowance | 1,000,000 scheduling units per agent per UTC day |

Each call reserves serialized request bytes + generated-token cap + 2048 overhead units before contacting the provider. This is a conservative scheduling policy, not a tokenizer or a hard dollar-spend guarantee. Reservations are never refunded after failures or timeouts because those calls may still be billed. Successful responses also record the provider-reported input/output token counts. Add provider-account billing limits and measured per-model costs before launch. There are no automatic retries: one paid provider attempt per agent/round. The request cap applies to failures as well as successes.

The worker has eight simultaneous call slots by default, configurable from one to sixty-four per process. It schedules earlier round deadlines first. Persistent claims prevent two workers from duplicating a particular agent/round call, and a separate persisted lease chooses the match clock. Concurrency is per process; cluster-wide inference admission and multi-host scaling remain deployment work. Concurrent matches need measured capacity; insufficient capacity leads to wait actions rather than extending deadlines.

## Private input and recovery

An agent receives mechanics, its strategy/notes, its scoped observation, and its previous accepted memory. Opposing pending actions, hidden map cells, other agents' cargo/memory, private seeds, API tokens and wallet credentials are excluded. Notes and model memory never enter public spectator snapshots or full game replays. Game state remains server-held; this is not a proof of operator blindness or fair execution. Model-provider isolation and the game's server trust assumptions need a production review.

The database records a unique call claim and its request charge before network execution. When a call lease expires after interruption, the worker locks wait if that turn is still active. It never repeats an uncertain provider call. Failed/invalid output also locks wait. A result arriving after the round, after another runtime's locked action, or after cancellation is discarded and cannot become next-round memory. Shutdown aborts outstanding calls before the database closes.

Stopping automatic entries leaves current match decisions running. Permission expiry applies to entry, not to finishing a committed game. The clock continues independently; there is no game pause control.

## Validation status

Local tests cover scoped Rush observations, strategy/memory isolation, duplicate worker claims, leases, deadline changes, shutdown, malformed/refused/incomplete output and exhausted request/allowance budgets. They use mocked providers, spend no inference credits and move no USDC. Live same-model playtesting, strategic diversity, balance, costs and provider latency are still required. Different notes/private information make divergence possible; they do not guarantee interesting competition.
