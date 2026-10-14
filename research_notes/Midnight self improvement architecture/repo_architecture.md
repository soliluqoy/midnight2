# Midnight repository architecture for shared self-improvement and per-user customization

> **Historical research — 13 October 2026, before the v0.6.0 implementation.** The v0.5.0 inventory and statements that builder/plugins/recovery are absent describe the researched baseline. They must not be used as today's implementation checklist. See the [reconciled architecture](../../reports/Midnight%20self%20improvement%20architecture.md) and [current implementation status](../../docs/realtime-implementation.md). Repository links navigate to current files; obsolete source line numbers have been removed.

Research date: 13 October 2026. Read-only source research; no product edits, package installations, tests, model calls, or deployments performed. Scope includes BOTH improvements/repairs of the shared Midnight application and independent customization of each user's installation from the first implementation slice. Evidence below separates implemented behavior, historical recorded tests, and proposed architecture.

## What exists in the app today, and can its conversational AI already repair it?

### Takeaway

Midnight already has a useful foundation: an Electron shell, a separate supervised Pi engine, app-owned missions and action journal, typed IPC, scoped file access, and explicit tools. It does not yet have the repository/patch/process/build/preview/update pipeline needed for a prompt to change its own code; installing the Pi coding-agent SDK did not automatically expose its coding tools.

### Cited Findings

- Current package is Midnight 0.5.0, ES modules, Electron 44.4.5, electron-builder 26.15.3, with Node 24 specified in development instructions. Dependencies include eight vendored Pi-family 1.0.1 packages, Transformers.js, PDF.js, sqlite-vec and TypeBox. The provenance manifest's top-level source is upstream and every Pi package entry is version 1.0.1. [package](../../package.json), [dependencies](../../package.json), [README development](../../README.md), [provenance](../../vendor/PROVENANCE.json).
- CLAUDE.md prohibits AI attribution and says to build midnight.server before npm run vendor and npm install after modifying that sibling core. ADR 0002 explains the separate vendor:upstream path and preserves the old credentials directory explicitly; current provenance shows upstream. No applicable AGENTS.md was found in the repository or ancestor directories checked. [CLAUDE.md](../../CLAUDE.md), [dependency ADR](../../docs/adr/0002-dependencies.md), [provenance](../../vendor/PROVENANCE.json).
- Only runtime/adapter.mjs imports Pi APIs; architecture tests enforce that boundary. It creates a mission-local persistent SessionManager session, passes an explicit list of custom tools, and adds a tool_call gate. Pi owns model calls, retries and compaction; Midnight owns missions, outcomes and policy. [adapter](../../src/runtime/adapter.mjs), [session/resources](../../src/runtime/adapter.mjs), [architecture guard](../../test/architecture.test.mjs).
- The adapter disables ambient extensions, skills, prompts, themes and context files. Its extraExtensions factory is an internal function argument; createHost currently does not pass one. The host accepts extraTools internally but mission-visible tool selection remains the static list from buildTools.forMission. There is no user plugin loader exposed by these seams. [loader](../../src/runtime/adapter.mjs), [host runtime assembly](../../src/runtime/host.mjs), [tool map](../../src/runtime/host.mjs), [mission selection](../../src/tools/index.mjs).
- The Electron shell owns the tray and utilityProcess supervisor. The host owns SQLite, runtime, mission coordinator, broker, budgets and scheduling, and does not import Electron. Its desktop operations go through a fixed platform table. Engine failures reject pending requests, cancel platform calls and trigger bounded restart attempts while the shell stays alive. [host](../../src/runtime/host.mjs), [supervisor](../../src/desktop/supervisor.mjs), [platform table](../../src/desktop/platform.mjs).
- Main UI is a fixed local HTML page. Its renderer is sandboxed with context isolation and no Node integration; navigation and new windows are denied. Preload exposes named methods. IPC version 1 validates sender/frame/origin, sequence, size, known method and schema, and intentionally has no generic execute method. [window](../../src/main.mjs), [trusted origin routing](../../src/main.mjs), [contract](../../src/contracts/ipc.mjs), [validator](../../src/contracts/ipc.mjs), [preload](../../src/preload.cjs).
- Current tool assembly exposes mission planning/questions/memory, constrained files/search/media reads, spreadsheet reading, deterministic calculation, chart/report/slides, demo CRM/mail, web/browser/computer operations, and user-added MCP tools. There is no command-shell/PTY executor, generic code patch/write service, Git/worktree manager, build/test tool, app source resolver, candidate preview, or builder job route in this registry. shell-tools.mjs means operations in the Electron shell. The core IPC test expressly rejects shell.exec as an unknown method. [registry and tool names](../../src/tools/index.mjs), [shell-tool meaning](../../src/tools/shell-tools.mjs), [IPC test](../../test/foundation.test.mjs).
- Every app-authored tool has a classifier plus execution and optional verification/reconciliation hooks. Broker persists the canonical action before dispatch, authorizes it against mission mode/grants/exact approval, checks privacy and stop state, locks resources, rechecks authority, dispatches and records a receipt. Unknown effects are denied. Existing effects do not name command execution, extension activation, or app release installation. [broker](../../src/policy/broker.mjs), [gate](../../src/policy/broker.mjs), [dispatch](../../src/policy/broker.mjs), [effects](../../src/contracts/domain.mjs).
- Skills today are bundled JSON workflow manifests, loaded once into a Map from a configurable directory. They cannot grant permissions or contain install/scripts/exec; tool names and capabilities are validated. Recipes capture verified tasks and have reviewed import/export/run flows. These are guidance/workflow extensions, not executable app plugins. [skill registry](../../src/skills/registry.mjs), [validation/loading](../../src/skills/registry.mjs), [recipes](../../src/skills/registry.mjs).

### Inferences

- The normal conversational runtime cannot spawn a scoped builder today. A new explicit builder delegation tool and job/runtime routes are required; putting a new tool in extraTools alone is insufficient because the active mission list must also offer it.
- Preserve existing mission/reconciliation semantics while introducing the builder. Treat generation and activation separately: the AI can prepare a reviewable candidate, but candidate activation is an app-owned operation bound to the exact content hash, permissions and base version.
- A Node/Electron utility process provides crash isolation, not automatically filesystem, credential, process or network confinement. A builder or executable plugin must receive a narrow service protocol and an actual restricted execution strategy; choosing a workspace cwd does not confine arbitrary code.

### Gaps

- No user-facing plugin manager, safe-mode loading path, builder worker, independent repair process, app-code version selector or source-toolchain provisioning system was found in the current src/contracts/runtime/settings/tools paths. This is absence in the inspected implementation, not a claim that every possible future script has been searched.
- No new test pass, timing or installed-build inspection is claimed here.

## Which prior decisions and tests should guide the design?

### Takeaway

The existing SDK plus Midnight journal decision is substantive and implemented. Durable was tested as a spike, not shipped as a second production engine; earlier rebuild/runtime reports describe proposed extensions that current code still lacks.

### Cited Findings

- Accepted ADR 0001, dated 4 October 2026, records the Windows-local comparison of Durable 1.0.1 and coding-agent SDK 1.0.1: both could repeat a model-requested external send after resume; Durable's MCP factory compatibility and maintainability gates failed; SDK direct and nested tool-call interception passed. It chooses coding-agent SDK plus Midnight journal and says mission success comes from Midnight's checks. These are historical repository-recorded measurements, not rerun results. [runtime ADR](../../docs/adr/0001-runtime.md).
- The Durable spike imports pi-durable and opens node:sqlite storage; its unsafe send writes effects.log, hangs, and is resumed after a kill. pi-durable is absent from current production dependencies. Current runtime directly uses createAgentSession/SessionManager. [Durable spike](../../docs/spikes/runtime-gate/durable.mjs), [package dependencies](../../package.json), [adapter](../../src/runtime/adapter.mjs).
- Some ADR paths are stale: it refers to runtime/broker-extension.mjs and test/runtime-adapter.test.mjs, neither present now. The actual broker gate is adapter.gateExtension; current guards live in architecture.test.mjs, broker/adversarial/e2e tests and runtime-gate spike scripts. [ADR rules](../../docs/adr/0001-runtime.md), [gateExtension](../../src/runtime/adapter.mjs), [architecture tests](../../test/architecture.test.mjs).
- Architecture tests enforce low-level contracts, Pi imports confined to the adapter, host modules without Electron, renderer without Node/module imports, and preload/contract/host method alignment. They are useful constraints for a plugin SDK and builder protocol, not evidence that arbitrary external plugin code is confined. [architecture test suite](../../test/architecture.test.mjs).
- Existing tests cover exact approval binding, duplicate send refusal, unknown outcomes/reconciliation, revoked grants, stop/privacy/budget blocks, canonical paths and resource locks; real-Pi faux-model end-to-end tests cover crash-during-send and interrupted read. Storage tests cover lock, consistent backup and restore. [broker tests](../../test/broker.test.mjs), [recovery tests](../../test/e2e.test.mjs), [storage tests](../../test/foundation.test.mjs).
- The model evaluation runner uses the real host with fixtures and demo connectors, performs paid model calls outside npm test/CI, and distinguishes forbidden effects as critical. Browser/desktop scenarios cannot actually execute headlessly. Its threshold requires zero critical violations. Existing task evals do not establish builder/plugin security or recovery. [eval runner](../../evals/run.mjs), [headless limits](../../evals/run.mjs), [thresholds](../../evals/scenarios.mjs).
- docs/rework-status.md is dated 4 October and reports historical 52/52 tests and partial model evaluation. Its still-pending MCP and voice statements are stale relative to current code. The 12 October app rebuild report is explicitly an implementation proposal with no production edit or new comparative benchmark, and the runtime report is explicitly a proposal for a new Windows-first runtime. Treat their terminal/worktree/runtime packaging sections as plans. [historical status](../../docs/rework-status.md), [app rebuild status](../../reports/Midnight%20app%20rebuild%20plan.md), [runtime proposal](../../reports/Midnight%20runtime%20implementation%20plan.md).
- Release workflow runs unit/e2e/adversarial/architecture, UI, Apps, smoke and rendering checks, builds platform artifacts, smoke-tests packaged Windows ASAR/native pieces, writes SBOM/provenance, and creates a draft release for a person to publish. [CI checks](../../.github/workflows/release.yml), [packaged checks](../../.github/workflows/release.yml), [draft publication](../../.github/workflows/release.yml).

### Inferences

- Retain one production Pi adapter and the app-owned journal for the first self-change slice. A switch to Durable does not supply source access, builder isolation, extension packaging, verification or rollback, and the app-owned external-effect journal remains necessary whichever runtime is selected.
- Requalify any newer runtime against direct/nested broker hooks, persisted-session reopening, stop, MCP, packaging and duplicate-effect fixtures; neither an old SDK test nor a marketing description qualifies a new version.
- Add meaningful builder-specific adverse tests: a stale base version, edited candidate after approval, process crash during activation, dependency/API mismatch, failed migration, attempted source escape, loss of engine/UI, and isolation between two users' custom versions. These are proposed tests, not existing passes.

### Gaps

- No current broad real-model benchmark, arbitrary plugin confinement result, builder holdout or safe-mode recovery result was found. Existing docs explicitly distinguish proposal targets from achieved measurements.

## Which seams should become plugins, and what should remain core?

### Takeaway

Use a small stable core plus several extension types. The current modular services are a strong starting point, but executable plugins should not inherit the entire host services object or mutate policy; workflows/themes, tool packages, UI views and app-core patches need different contracts.

### Cited Findings

| Existing seam | Evidence and implemented constraint | Suitable first extension type |
|---|---|---|
| Skill packs and recipes | createSkills accepts a directory but reads it once; JSON prohibits code/install/permission grants. [registry](../../src/skills/registry.mjs) | Declarative workflows, user instructions, recipe templates; add user-layer composition and versioned reload. |
| Tool assembly and ToolSpec-like objects | buildTools assembles modules; host wraps every offered tool through broker.execute. [assembly](../../src/tools/index.mjs), [wrapper](../../src/runtime/host.mjs) | Package selected document/calculation/authoring tools behind a manifest and broker service API. |
| Document helpers | workTools uses pure document modules, deterministic calculations and round-trip validators. [work tools](../../src/tools/work.mjs) | Small bundled first-party feature plugin; generate a user-specific variant from its canonical source. |
| Connectors | Registry has identity/version/account/scopes, rate limits and explicit operation dispatch; MCP schema digest identifies review state. [registry](../../src/connectors/registry.mjs), [MCP digest review](../../src/connectors/mcp.mjs) | External tool/connector extension behind existing broker, credentials and account-selection boundaries. |
| Search/voice workers | Search and speech already use dedicated worker threads; services depend on model pins, lifecycle/settings/media platform calls. [search runtime](../../src/search/runtime.mjs), [speech runtime](../../src/voice/runtime.mjs) | Later first-party service plugins, after lifecycle/resource protocols exist; higher coupling than document tools. |
| UI panels | Current plain renderer has no module imports, fixed HTML/IPC/preload; the MCP App viewer is separately sandboxed. [renderer guard](../../test/architecture.test.mjs), [MCP view](../../src/desktop/mcp-app.mjs) | Declarative theme/UI contributions or isolated views with an explicit typed bridge; do not import arbitrary renderer code globally. |

- Most host services are assembled together, and buildTools receives store, journal, broker, roots, platform, settings and other authority-bearing objects. This currently suits trusted bundled code; it is not an appropriate public plugin API. [host services](../../src/runtime/host.mjs), [tool assembly](../../src/tools/index.mjs).
- Current module registries/loaders are constructed at host creation or new mission run; there is no established dynamic-code unload/replace protocol. Adapter recreates the session/resources per run and disposes sessions afterward; skills are read at registry construction. [adapter lifecycle](../../src/runtime/adapter.mjs), [session disposal](../../src/runtime/adapter.mjs), [skill loading](../../src/skills/registry.mjs).
- Ledger records tool version and runtime version; stored approved actions are redispatched by current tool name and reclassified to check their canonical hash. Plugin replacement needs stronger immutable version binding so an old intent cannot silently dispatch a newly replaced implementation. [ledger](../../src/policy/ledger.mjs), [stored dispatch](../../src/policy/broker.mjs).

### Inferences

- Keep bootstrap/supervisor, IPC and extension protocol, policy/effect classifiers, grants, approvals, stop, action ledger/receipts, secrets, storage ownership/migration rules, verification, installation/update trust and safe-mode recovery in the core. Bundled plugins may implement most product features while the core controls their authority and lifecycle.
- Begin with a declarative user theme/workflow and one small document feature plugin. This proves shared feature source plus private variants without trying to make every core module dynamically replaceable.
- Executable plugin manifests should describe id/version/content hash, host API range, dependencies, tool schemas, required capabilities, entry point/type and state schema. Classifiers and permissions must be host-enforced or tied to reviewed trusted implementations; untrusted plugin claims cannot authorize actions.
- Prefer immutable package versions in separate workers with drain/dispose/restart behavior. Pin active versions for a mission; prepare a new version, preview/test it, atomically change the active pointer when idle, and retain the previous version. Avoid attempting to invalidate every ESM import and DOM side effect in a running host.
- Preserve an emergency recovery shell that loads no user extensions. Extending product functions is useful; allowing a plugin to replace the component that judges whether it may run would destroy the established boundary.

### Gaps

- There is no current public plugin SDK, feature dependency graph, migration contract, supported UI mount points, package registry, lifecycle protocol, or hot-reload compatibility policy. These must be implemented rather than inferred from the existing file/folder organization.

## How should shared improvements and each user's custom version work from the beginning?

### Takeaway

Use an immutable official base and versioned per-user overlays, backed by the same app-builder pipeline and distinct publish targets. Shared changes become official source/release candidates; each user installs their own compatible plugin/config version without carrying a fork of the whole executable.

### Cited Findings

- Builds package src and package.json into ASAR, exclude tests and C# native source, and use platform installers/archives. Build scripts and a development checkout are not part of the declared packaged source set. NSIS is per-user/no elevation and preserves app data on uninstall. [packaged files](../../package.json), [targets](../../package.json), [NSIS](../../package.json).
- Packaging disables RunAsNode, NODE_OPTIONS and inspect, requires app.asar and embedded integrity checks, expressly to prevent installed code editing. An installed midnight.exe cannot serve as the builder's general Node toolchain. [after-pack explanation](../../scripts/after-pack.cjs), [fuses](../../scripts/after-pack.cjs).
- The current updater verifies a release manifest SHA-512 and valid Authenticode signer matching the running app, takes a database backup and launches the installer. Unsigned/currently unmatchable builds open the release page. The backup callback uses the engine, and main's actual busy callback checks active missions and screen lease, not every waiting mission described in the updater comment. [trust check](../../src/desktop/updater.mjs), [installation](../../src/desktop/updater.mjs), [main integration](../../src/main.mjs), [tests](../../test/updater.test.mjs).
- dataPaths separates sessions/workspaces/backups/logs/exports under app userData. The artifact store creates per-mission directories and revision-numbered files with SHA-256 and validation metadata. These are output workspaces, not Git source sandboxes or app revisions. [paths](../../src/runtime/paths.mjs), [artifact revisions](../../src/evidence/store.mjs).
- MIDNIGHT_USER_DATA and MIDNIGHT_CORE_DIR allow disposable UI/credential profiles in current tests; the packaged smoke harness uses both. This is a reusable candidate-preview mechanism, with source/build and plugin isolation still to add. [profile override](../../src/main.mjs), [smoke harness](../../scripts/smoke.mjs), [credential paths](../../src/runtime/paths.mjs).
- SQLite has a single owner, WAL plus synchronous FULL, transactional forward-only appended migrations, consistent backups and a restore function requiring the store to close. Older binaries open a newer schema read-only. This is data recovery groundwork; it does not constitute a UI/engine-independent rollback action or a plugin state migration system. [storage](../../src/storage/db.mjs), [schema handling](../../src/storage/db.mjs), [migration rule](../../src/storage/migrations.mjs), [restore](../../src/storage/db.mjs).
- Crash recovery reconciles unknown effects and retries only declared safe effects before restoring missions. Main's tray Restart engine survives renderer failure; renderer process loss reloads the UI. Neither action switches to a previous base/plugin version. [recovery](../../src/missions/coordinator.mjs), [tray](../../src/main.mjs), [renderer reload](../../src/main.mjs), [supervisor restart](../../src/desktop/supervisor.mjs).

### Inferences

#### Initial version/state model (proposed, required for both scopes)

- BaseRelease: app version, exact source commit/archive hash, extension API version, core schema version and platform/build provenance.
- ExtensionVersion: stable id, version, content hash, source/base reference, API range, dependencies, requested capabilities, origin (official/user/local), parent version and state schema.
- UserInstallation: user/profile id, active extension-version map, declarative settings/theme overlays, granted capabilities, previous known-good map and migration checkpoints. Keep each user's code and state namespaces separate; private customization must not become another user's default.
- BuilderJob/ChangeCandidate: scope (shared or user), requesting mission/user, base release, source refs, isolated worktree/workspace, immutable patch/package digest, output/log/test artifacts, candidate status and activation/publish target. Shared and user jobs share the builder protocol, not the active install or data directories.
- Host owns registries and activation state; plugin state belongs in per-plugin namespaces with separate reversible migration contracts. Do not restore an entire mission database solely to undo a visual/custom-plugin change and lose receipts of later external effects.

#### New builder/repair routes and worker responsibilities (proposed)

1. Add a brokered builder_request tool to normal missions, and explicit builder.create/status/cancel/preview routes in the contract/preload/host plus an independent shell-owned repair route. Record the target scope and exact base before coding begins. A normal conversation may delegate the job; it cannot grant new capabilities to its builder.
2. Source service resolves canonical feature/plugin source or a shared checkout at the exact base commit. For installed users, fetch a verified source capsule/template and a pinned builder toolchain on demand; the ASAR contains runnable assets, not the complete development environment. Users should not need to replace the signed executable for ordinary customization.
3. Builder worker runs its own Pi session in an isolated worktree/workspace and only receives approved source read/patch, package/build/test and preview services. Introduce honest execution/activation effect classes and restricted command/runtime policies; do not classify arbitrary shell execution as deterministic compute or ordinary local.write. Worker's permission scope, cancellation, process-tree lifecycle, budget and network access need implementation.
4. Stage candidate as an immutable version, run contract/adverse tests and preview in a disposable profile. Normal feature preview should use separate data and credentials; granting access to real accounts is a distinct explicit step.
5. Host creates the reviewable diff, actual test results, requested capability changes and preview artifact. A user installs the exact local candidate for themselves; a shared candidate goes to review/CI/release with publisher controls. Activating a local plugin and installing an official executable are different trust chains.
6. Activate through the trusted core at an idle/drained boundary, bind old/new hashes and compatible base/API version, preserve the previous active map, monitor candidate health, and automatically disable a crash-causing extension. A base upgrade checks every user's overlay API compatibility; incompatible local versions remain preserved but disabled/rebuildable, not silently rewritten into the new base.

#### Stable repair entry point (proposed)

- Extend the existing trusted tray with Repair Midnight and startup flags such as safe-mode/repair that skip user extensions. Its small repair window and job supervisor must survive normal renderer and engine/plugin failure and must not require a successful host.data.backup request to disable a bad extension or select the prior version.
- Keep extension activation/last-good metadata in a small atomic core-owned record that can be read before normal host/plugin startup. Provide disable all customizations, choose previous active package set, export diagnostics and reinstall the known-good base. The normal broken feature must not be the only route to its own repair.
- If the shared base shell/executable itself cannot start, an independent launcher/recovery helper or reinstall path is required. An AI embedded exclusively in the failing binary cannot repair it. Core changes need a separately built candidate and base-version rollback, not in-place ASAR mutation.
- Builder repair sessions use trusted builder code and scoped diagnostics with secrets removed; changed plugin code should not automatically inherit provider auth files, vault/store handles or account tokens.

#### Prioritized first implementation slice (proposed)

Ship the smallest full loop that demonstrates both scopes: extract one existing document/calculation/authoring feature as a bundled official plugin with canonical source; support a per-user variant and a declarative theme/workflow overlay; add an independent builder worker with scoped patch/build/test, disposable preview, exact version activation and one-click previous-version restore. Include a shared-target job that yields an official plugin/source change candidate and CI/release output; include a user-target job that installs only into that user's active map. Keep the core and existing Pi runtime unchanged except for these contracts and supervision seams. Neither scope is postponed.

First code touchpoints: src/contracts/ipc.mjs and preload.cjs for typed builder/extension operations; src/runtime/host.mjs and tools/index.mjs for scoped delegation; new builder and extension registry/version-state modules; src/tools/work.mjs/documents as the first feature extraction; src/main.mjs and desktop/supervisor.mjs for preview/repair entry; src/storage/migrations.mjs only for core-owned registry/job records; a per-plugin state store; packaging/source-capsule support; meaningful recovery/isolation tests. This ordering follows the implemented boundaries cited above.

### Gaps

- No current signed production chain was inspected; current docs/README say builds are unsigned. The updater's code supports same-publisher trust, but that is not evidence that a certificate is configured or releases are signed today. [README](../../README.md), [historical signing limitation](../../docs/rework-status.md).
- Toolchain/source-capsule delivery, plugin permission confinement, official/user package trust rules, compatible rollback after plugin migrations, publication/review workflow, multi-device sync and plugin market distribution remain design/implementation work. A generic marketplace is unnecessary to prove this loop.
