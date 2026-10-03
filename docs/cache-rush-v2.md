# Cache Rush mining implementation

Implemented locally on 2026-10-01. This replaces the surface-token prototype for new Rush matches. The previous engines stay available for old recordings. The executable server admits new Rush expeditions and marks Flux Duel Coming soon; Duel creation is rejected and public entry controls are disabled.

## Presentation

Update on 2026-10-02: the match HUD and popup use bronze/forest game materials, miner portraits and a top-three podium. Native fullscreen has enter/exit controls on desktop and mobile; a browser that denies it receives an explicitly described expanded view. Sound is preferred on by default, activates on a gesture when required, remembers volume/mute, checks the running context, and provides an output meter and paused-replay-safe test. A compressor protects overlapping effects. The text-free Cryptrix emblem is generated and installed; the original prompt history remains local.

The spectator route owns the viewport: a compact header, a full 2D canvas field and a compact playback/status bar. Site navigation and footer do not consume the match viewport. Before the final walking-pose additions, real browser checks at 1280 × 720 and 390 × 844 confirmed scrollY=0, controls at the viewport bottom and no horizontal overflow. A fresh final browser check was interrupted by the local preview being unavailable; restore the preview and recheck after the user reopens it.

Generated hand-painted miners have separate idle, raised pickaxe, strike, cargo-walk and empty-pack walking poses. Terrain uses four ground textures with irregular biome boundaries. The canvas renders visible deposits, mining props, extraction stations, clinics and plants; excavation depth, empty pits, cracks, rubble, snakes and dropped diamonds come from engine state. Actors and props share depth ordering. Bright separation rings and numbered upright badges keep miners visible on every terrain. The renderer waits for all sprite sheets before drawing, including during development refreshes.

Movement follows the actual job path. Digging alternates tool poses and emits dust; inspection draws scan rings; extraction lifts diamonds; cave-ins produce debris and a brief camera shake. Snakes have coiled and strike art. Venom shows a countdown, treatment shows a cure event, and elimination leaves a collapsed miner and dropped cargo.

Camera controls: normal wheel scrolls vertically, Shift + wheel scrolls horizontally, and trackpad horizontal motion pans sideways. Zoom uses +/− buttons, Ctrl/Command + wheel or two-pointer pinch. Pointer drag and keyboard arrows pan; full-map overview, clickable minimap, agent follow and optional event-driven broadcast camera remain available. Manual scrolling exits the broadcast/follow camera so it cannot pull the view back. Crown and major hazard announcements take priority over ordinary finds. Mobile has a two-row miner dock. Sound requires a user gesture and covers steps, pickaxe impact, treasure, extraction, snakes, bites, urgent venom, collapse and outcome. Paused/hidden replay views stop audio. Gameplay continues on the server when a spectator leaves or hides the tab.

The homepage features an actual recorded Rush excerpt, clearly labelled practice. Rush is the default entry game. Main interface colors remain warm cream, earth and olive; bright miner/gem colors identify gameplay objects.

## Engine and integration

Map revision 3 retains revision 2’s changes to the terrain regions, spawns, stations, clinics and Crown location in addition to deposits and hazards. Each match uses its already-existing fresh 32-byte random seed. Spawn-to-extraction distance is equal at two tiles; carved routes connect all critical destinations. The revision enters the committed rules hash. Existing revision-one and revision-two recordings select their original generator/rules and still verify. Revision three reduces visible clues to 18% of eligible outer ground and 34% of eligible interior ground; 22% of clues are empty, while unmarked ground can conceal a small pocket. Spawn and station surroundings carry no deposits; the Crown is placed away from these locations. Tests exercise deterministic variation and reachability across 32 seeds.

See [rules](game-rules.md), [runtime command API](backend-api.md) and [hosted execution](hosted-agents.md). The engine runs a deterministic 500ms simulation with 1-second replay snapshots; accepted commands are timestamped independently per miner. The SDK and model worker support the same high-level job protocol. Each miner has a 20-decision allowance; strategy bots reserve late jobs for extraction. Banked ranking conserves the filled pool including ties.

`backend/scripts/export-mining.ts` produces the four-minute practice recording using eight independently configured local strategy miners. Every exported recording is reconstructed and verified before writing; discoveries, bites, cures, elimination and payouts are engine results. No funds, wallet keys, fake player counts or scripted winners are involved. Replay frames omit repeated static terrain to keep the recording about 2 MB before transport compression.

Existing paid admission, ownership, quotas, escrow and restricted signer boundaries remain in place. This implementation is local practice; production deployment/provider configuration and production capacity measurements remain separate work.

## Validation

2026-10-02 update: 68 backend tests, 7 contract tests and 11 frontend tests passed. The new verified dynamic-map recording includes Crown extraction, venom treatment, cave-ins, elimination and dropped-treasure recovery. The browser inspection tool fails before initialization with "failed to write kernel assets: The system cannot find the path specified" even after a reset, so a fresh desktop/mobile visual check and audible speaker check remain unconfirmed. Local HTTP checks pass. Preview services were started as hidden background processes to survive chat continuations.

The complete backend check passed: 66 backend tests and 7 contract tests. All 9 frontend tests passed, and the production frontend build passed. Local preview is served on port 5173; the ignored local environment files point its API proxy at Cryptrix's backend on port 3010 because another project owns port 3000. No unrelated project process was stopped.

New tests cover independent jobs, hidden underground information, snake windup, poison treatment and elimination, banked score retention, Crown extraction, cave-in warning/clearance, clock regression, authentication, idempotency, command allowance, pool conservation and replay tampering. A hosted worker test checks independent sequences, scoped bounded prompts, private memory and no extra calls for footsteps/tool work. Frontend tests cover the full timeline, seeking/spawns and path interpolation. Existing wallet, contract and legacy engine regressions also run.

## Art provenance

All new bitmap assets were generated with the built-in ImageGen tool, then optimized to WebP with Sharp. Originals remain in the tool's generated-images directory. Production copies:

- `frontend/public/art/miners-a.webp`: four miners × idle/raised/strike/carry poses; original `exec-5c8bec36-b40f-472b-9254-7b70f7816424.png`.
- `frontend/public/art/miners-b.webp`: four additional miners × the same poses; original `exec-ede0c1a9-f77f-4fdc-a743-20da4266d008.png`.
- `frontend/public/art/mine-props.webp`: 16 terrain/creature/treasure/station props; original `exec-b5471be9-dfbc-430b-bd31-fcb36f2ec68f.png`.
- `frontend/public/art/mine-terrain.webp`: four ground textures; original `exec-29af2214-21bc-43ca-b35a-3941e6fd902a.png`.
- `frontend/public/art/miners-walk.webp`: superseded single empty-pack walk poses; original `exec-709ce893-1cda-4d2f-b225-cb769f9e1663.png`.

- `frontend/public/art/miners-walk-empty-v2.webp`: all eight miners, two empty-pack walking frames; original `exec-45b70b3c-1c33-4034-b86d-87cfbaf573f2.png`.
- `frontend/public/art/miners-walk-loaded-v2.webp`: all eight miners, two loaded walking frames; original `exec-a722c264-26fb-4345-9884-dfa0851eec0a.png`.

The original art prompt set remains local. Transparent miner/prop alpha is preserved. No raster sprites were replaced with geometric placeholders.


Automatic camera holds a miner for 12 visible seconds after arrival using a game-independent monotonic viewing clock. Zoom is fixed per shot; movement only pans. Major Crown/death events queue during transitions and can interrupt after a six-second minimum hold. Distant subject changes use a wide/travel/close sequence, while nearby changes pan directly. Explicit seeking/new match identity resets the director; live clock corrections do not. Close shots use a safe area around HUD overlays and frame edge miners fully; brief gaps while model decisions are pending retain the current miner; sustained inactivity can return to the overview. Dragging, scrolling or zooming disables Auto until the spectator enables it again. The canvas frame chain survives individual drawing faults and handles context restoration. During local model tests, sanitized renderer faults are available alongside inference diagnostics; completed successful matches are archived automatically.

Walking now combines two dedicated illustrated poses with alternating boot articulation for all eight identities and both cargo states. Frame baselines are normalized during art preparation; backpacks remain visible, and heavier cargo slows the gait. Mining, rock clearance and snake repelling animate the raised/strike tool poses.

Full-map view is the default on match entry and Watch again. Automatic broadcast movement is opt-in using Auto, and selecting a miner explicitly enables that follow view.
