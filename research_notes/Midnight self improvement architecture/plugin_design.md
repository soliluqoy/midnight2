# Midnight self-improvement architecture: plugin boundaries and durable change jobs

> **Historical design research — 13 October 2026.** Proposed interfaces and stages below are the original design, not a current completion report. The chart/color plugin pilot, exact-artifact dispatch, separate builder and damaged-cache recovery are implemented in v0.6.0. See the [reconciled architecture](../../reports/Midnight%20self%20improvement%20architecture.md) and [current implementation status](../../docs/realtime-implementation.md) before planning more work. Repository links navigate to current files; obsolete source line numbers have been removed.

Research date: 2026-10-13. Repository inspected read-only; no product changes, installs, or tests performed. The user confirmed two requirements from the beginning: independent customization of each user's Midnight and improvements/repairs to the shared official app. Recommendations below are architectural proposals, not claims of functionality already implemented.

## Which approach best supports both official improvement and per-user customization?

### Takeaway

Recommend a hybrid: an official, versioned base; per-user declarative and executable extensions; and a separate maintenance workflow capable of changing official core source. Making most features extensible helps customization, but a small recovery kernel and a core-change lane remain necessary.

### Cited Findings

- Midnight already uses Pi coding-agent SDK 1.0.1 with a Midnight SQLite mission/action journal. The local runtime ADR records that an interrupted send was duplicated after Durable resumed; the selected SDK also requires Midnight to own effect reconciliation. This is measured repository evidence dated 2026-10-04, not an assertion about every current upstream version. [ADR 0001](../../docs/adr/0001-runtime.md)
- Pi ambient discovery is explicitly disabled; only supplied extension factories and tool definitions are loaded. Enabling arbitrary home-directory Pi extensions would change the current trust model. [adapter.mjs](../../src/runtime/adapter.mjs)
- Tools are assembled at a single `buildTools` seam; connector factories already expose registration; skill packs are versioned JSON guidance and reject install scripts/authority grants. These are practical initial extension seams. [tools/index.mjs](../../src/tools/index.mjs), [connectors/registry.mjs](../../src/connectors/registry.mjs), [skills/registry.mjs](../../src/skills/registry.mjs)
- Registering an extra tool is insufficient for model visibility: `forMission` currently offers a fixed list. Stored-intent dispatch currently looks up the tool by name, which must be changed to retrieve the pinned version/artifact before executable plugin updates. [Tool selection](../../src/tools/index.mjs), [stored-intent dispatch](../../src/policy/broker.mjs)
- The packaged executable disables RunAsNode/NODE_OPTIONS/inspector and requires an integrity-checked app.asar. The packaging list includes product source and package.json, excludes tests, and does not include a complete source checkout/build toolchain. Installed users cannot simply edit their live archive and rebuild it using the existing developer workflow. [after-pack.cjs](../../scripts/after-pack.cjs), [package.json](../../package.json), [README](../../README.md)
- VS Code uses documented contribution APIs and an extension host, prevents extensions from accessing its workbench DOM, and loads extensions through activation events. This supplies a useful pattern without requiring Midnight to adopt VS Code's full platform. [Extension host](https://code.visualstudio.com/api/advanced-topics/extension-host), [Extension capabilities](https://code.visualstudio.com/api/extension-capabilities/overview)

### Inferences

**Recommendation: three change surfaces, sharing one job model.**

| Surface | Appropriate requests | Activation scope | Main tradeoff |
|---|---|---|---|
| Declarative customization | Change colors, layout preferences, commands, prompts, recipes, skill packs, configured workflows | Only this user's overlay | Cheap validation and rollback; cannot repair arbitrary runtime bugs |
| Versioned executable extension | Add a connector, formatter, pure tool, model adapter, dashboard or specialized panel | This user's explicitly installed version; official built-ins may use the same API | Wider behavior, but needs lifecycle/isolation/contracts |
| Official source change | Repair broker, launcher, search, renderer, storage or an extension-host API gap | Produces a proposal/branch/PR and candidate official build; published through the existing release process | Full power; requires build environment, release authority and recovery outside the candidate |

Support both destinations from the first change request. Ordinary users may generate an official proposal without acquiring permission to publish an official release. A local custom extension can be promoted into a reviewed official contribution after stripping private settings and data. A developer/owner may preview a core patch locally in a disposable installation; regular installed users should normally receive a core repair through the official release path.

Use separate identities and storage: reserve `midnight/<name>` for official extensions and `user:<installation-id>/<name>` for local ones. If a user modifies an official extension, create a local derived copy recording its original id/version/hash; do not silently overwrite the official package. Explicit bindings allow supported replacements such as a theme or preferred report formatter. Arbitrary replacement of policy, approval, secret or recovery services is outside the user extension API. An official update validates overlays against its API version, leaves incompatible overlays disabled with an explanation, and preserves their source.

**Recommendation: plugin boundaries by failure and change rate.**

| Feature family | Extension treatment |
|---|---|
| Skills, recipes, themes, configuration | Data contributions first; never confer authority by declaring capabilities |
| Tools and document/domain formatters | Register schemas and RPC implementations; retain the existing broker around every effect |
| Connector/provider/model adapters | Natural seams; capabilities, accounts and destinations remain checked by kernel-owned services |
| Workflows | Versioned compositions of existing brokered tools/checks; built-in scheduler executes them |
| Screens/widgets | Host-rendered contribution schemas first; separate guest panel for richer UI |
| Search/voice/media integrations | Optional backend services, after proving lifecycle/resource limits; large models/native dependencies argue for deliberate boundaries |
| Mission coordinator, durable ledger, permission broker, approvals, vault, IPC validation | Dependable kernel services; extensions consume scoped APIs |
| Supervisor, startup, activation registry, diagnostics, safe mode, last-good restoration, updater/repair UI | Dependable recovery kernel; modifications use the official core-change/release lane |

The kernel should be small in *exposed responsibility*, not necessarily a premature extraction into many packages. A screen can be extensible while the trusted approval/repair shell remains built in. Making every helper function a plugin would add dependency graphs, version contracts, serialization, startup ordering and cross-plugin debugging without improving recoverability. The useful rule is “most changeable features have explicit extension seams,” rather than “every file becomes dynamically replaceable.”

### Gaps

- No executable extension loader, activation registry or plugin-safe-mode flow was observed in inspected files. Existing seams are a foundation, not an already functioning plugin platform. [Current assembly](../../src/tools/index.mjs), [current supervisor](../../src/desktop/supervisor.mjs)
- This repository has explicit custom tools, but no observed general maintenance patch/worktree/build command interface. A dedicated maintenance tool set must be added; do not assume the Pi SDK import exposes arbitrary execution to the current model. [SDK custom tool binding](../../src/runtime/adapter.mjs)

## What small extension contract and isolation model should Midnight introduce?

### Takeaway

Recommend a small manifest with immutable artifacts and scoped RPC. Separate processes protect responsiveness and crash containment; actual hostile-code security requires a separately engineered sandbox or restricted browser/declarative execution.

### Cited Findings

- VS Code's manifest distinguishes extension identity/version, engine compatibility, entry points, contributions, activation and extension dependencies. These concepts are suitable inspirations; its marketplace fields are unnecessary for Midnight's first implementation. [Extension manifest](https://code.visualstudio.com/api/references/extension-manifest)
- Electron utilityProcess provides a child process with Node.js and message ports. This is suitable for a process host; it is not evidence that arbitrary Node code has only manifest-declared authority. [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- Node workers run JavaScript in parallel and may share memory. Node's current permission documentation explicitly states that its permission model does not provide guarantees against malicious code. Do not describe workers or Node permission flags as the complete untrusted-plugin sandbox. The permission source is current Node v26 documentation; implementation flags supported by Midnight's embedded Node v24 still require verification. [Node v24 workers](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html), [Node permissions](https://nodejs.org/api/permissions.html)
- A sandboxed Electron renderer has no initialized Node environment and uses IPC for privileged work; enabling Node integration disables its sandbox. Context isolation prevents a page from sharing the preload world, but the preload must still avoid exposing excessive authority. Electron also advises validating IPC senders and restricting local pages through custom protocols. [Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox), [Context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- Midnight already separates its trusted Apps shell (with preload) from guest `WebContentsView`s (sandbox, contextIsolation, no Node, separate sessions). Guest failures are tracked independently. Current registry URLs accept only http/https; product shell assets currently load through file URLs, so a plugin asset protocol would be a new addition. [app-workspace.mjs](../../src/desktop/app-workspace.mjs), [guest construction](../../src/desktop/app-workspace.mjs), [registry.mjs](../../src/apps/registry.mjs), [packaging fuse rationale](../../scripts/after-pack.cjs)

### Inferences

**Recommendation: proposed manifest, not existing schema.** Keep package metadata and runtime host authority distinct; a declaration requests capability but never grants it.

```json
{
  "format": "midnight.extension",
  "manifestVersion": 1,
  "id": "user:installation-123/report-helper",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "kind": "declarative",
  "entry": { "backend": null, "panel": "panel/index.html" },
  "capabilities": ["tools.invoke:files_read"],
  "dependencies": {},
  "configSchema": {},
  "contributes": { "skills": [], "tools": [], "commands": [], "panels": [] },
  "derivedFrom": null,
  "state": { "schema": 1, "reads": [1], "writes": 1 }
}
```

Start with allowed contribution kinds and one API major; add fields when a concrete feature needs them. Official/user identity is assigned by installer, not trusted from a file's self-description. Validate contributions and ids before registering them. Dependency declarations refer to exact resolved artifacts in an activation generation; reject cycles and incompatible API versions. Avoid arbitrary cross-plugin imports; provide narrow host APIs such as registerTool, contributePanel, log, config, pluginStorage and requestTool. Require effect tools to declare input/output schemas plus verification/reconciliation behavior. The host owns request identity, timeout, cancellation, budget, grant, account and root checks. For effect-free tools, a simple invoke/result RPC is sufficient.

**Recommendation: isolation graduated to actual need.**

- Declarative packs and host-rendered widgets do not execute package code. This is the least costly initial path.
- Rich user panels follow the existing WebContentsView pattern, using a new restricted `midnight-plugin://<id>/<artifact-hash>/...` protocol whose loader serves only that artifact's files. Keep Node disabled, sandbox/context isolation enabled, CSP restrictive, navigation/popups denied, browser permissions denied by default, and plugin sessions separate from website sign-ins. A host-owned preload exposes only the panel's narrow API; validate the sender webContents/frame/origin and bind it to the activated plugin hash. Never grant the panel the existing broad trusted-shell preload or inject its JS/CSS into the capsule. Declarative settings/theme tokens and UI slots are the primary customization surface; hosted guest panels are for richer screens. [Existing pattern](../../src/desktop/app-workspace.mjs), [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)
- For owner-trusted generated backend code or reviewed official modules, use a separately supervised child/utility process and a scoped host RPC. Do not load it directly into the policy-owning engine. Initially use one child per executable plugin when fault attribution matters; pool only after resource measurements justify it. Timeouts/crash budgets quarantine a bad version.
- Full Node code on the same user's machine can still access that user's filesystem/network outside RPC. Capability checking on host RPC is an architectural enforcement point, not a security guarantee against such code. For potentially hostile shared packages or shared-service builds, use a real restricted execution environment/isolated VM or an explicitly limited runtime, no production credentials and controlled networking; evaluate the actual Windows sandbox before promising guarantees. Worktree boundaries alone do not satisfy this.

**Recommendation: lifecycle.** `discovered → validated → installed → staged → activated → healthy`, with `disabled/quarantined/rolled-back` outcomes. Register contributions only after compatibility validation and an activation handshake. Activation and deactivation return disposables; host shutdown cancels calls and unregisters contributed commands/watches/panels. Do not require a broken plugin's uninstall/deactivate hook to restore the app. Keep artifacts immutable, including source, manifest, lockfile, hashes and build metadata. Pin each mission to the generation and exact tool/plugin artifact hash with which it began. Update at an idle boundary or start a new host; do not hot-swap code midway through an effect. Capabilities added by an update receive fresh review under applicable user policy.

### Gaps

- No verified OS sandbox design for this Windows installation was established. MVP claims should say “owner-trusted local code with crash containment,” or remain within declarative/browser isolation, until that engineering work is complete.
- Electron utility-process compatibility with Node permission flags and native packages needs a targeted spike before choosing flags. Browser panel preload/message protocol is proposed and needs security/conformance tests.

## How should prompt-to-patch jobs become durable, verifiable and recoverable?

### Takeaway

Recommend explicit change jobs with isolated source workspaces and immutable candidates, plus a tiny deployment journal and recovery path independent of the potentially broken app. Conversation checkpoints, artifact rollback and compensation for external effects are different operations.

### Cited Findings

- Git worktrees create separate working trees while sharing the repository; they keep HEAD/index/worktree files separate. This supports isolated branches without disrupting the developer's current working tree, but the documented purpose does not imply an OS security sandbox. [git-worktree](https://git-scm.com/docs/git-worktree)
- Existing Midnight ledger intents precede effects and receipts append; unknown/in-flight and already verified matching effects prevent blind redispatch. Reuse this mechanism for maintenance tool effects. [ledger.mjs](../../src/policy/ledger.mjs), [duplicate checks](../../src/policy/ledger.mjs)
- The current updater checks idle state, hash and same-publisher Authenticode, then calls a backup before launching an installer. In main, this backup depends on the engine, so it is not a complete recovery route for a broken engine/core. Current supervisor restart preserves shell/tray but is limited to bounded engine restart. [updater.mjs](../../src/desktop/updater.mjs), [install](../../src/desktop/updater.mjs), [main.mjs](../../src/main.mjs), [supervisor.mjs](../../src/desktop/supervisor.mjs)
- Store opening backs up before migrations, performs each migration transactionally, and opens newer schemas read-only by default. Consistent online backup uses SQLite backup rather than copying only the main WAL database file. A previous binary is therefore not automatically a fully functional rollback after a new data schema. [db.mjs](../../src/storage/db.mjs), [backup](../../src/storage/db.mjs)
- Existing QA commands include unit/recovery/policy tests, real Electron startup with a disposable profile, UI, Apps and visual checks. Smoke separates both user data and core/auth directories. [README](../../README.md), [smoke.mjs](../../scripts/smoke.mjs)
- npm ci requires a lockfile, fails when it disagrees with package.json, and does not update it. Ignoring install scripts does not suppress explicitly requested npm test/npm run scripts, so build/test execution itself still runs candidate code. [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)

### Inferences

**Recommendation: one durable job, two publication destinations.**

```text
requested → diagnosed → workspace-ready → patching → validating
          → preview-ready → awaiting-activation → activating
          → observing → accepted
failure exits: failed | cancelled | reconcile-required | rolled-back
official proposal: preview-ready → proposed → approved-for-release → released
```

```json
{
  "jobId": "change-123",
  "requestId": "client-idempotency-key",
  "scope": "user",
  "target": "user:installation-123/report-helper",
  "baseCommit": "exact-commit",
  "baseGeneration": "generation-17",
  "sourceSnapshotDigest": "sha256:...",
  "workspaceRef": "worktrees/change-123",
  "candidateDigest": "sha256:...",
  "status": "preview-ready",
  "checks": [{ "name": "smoke", "result": "passed", "evidenceRef": "..." }],
  "deploymentIntentId": null,
  "lastError": null
}
```

1. **Diagnose and classify.** Capture user intent, reproduction, expected behavior, scope, installed version, extension generation, redacted diagnostics and baseline checks. Attempt reset/disable/reconfiguration first when diagnosis supports it. Match candidate source to the installed official commit or exact local extension source; never hallucinate a buildable repository from packaged app.asar.
2. **Create a separate maintenance workspace.** Start a branch/worktree from a recorded base commit (or an isolated source bundle for installed users). Preserve existing developer dirt; if intentionally included, snapshot the relevant tracked/untracked changes explicitly without secrets. Main missions keep the current tool policy. A maintenance broker adds source-read/scoped-patch, fixed Git operations, approved build/test invocations and artifact staging, with argument arrays, canonical paths, time/resource bounds and redacted logs. It never provides the ordinary chat model an unrestricted generic renderer IPC execute method.
3. **Patch/build/check/preview.** Use existing pinned dependencies; first MVP disallows new executable dependencies by default. Any approved dependency change has a lockfile/integrity/provenance delta and explicit build-script policy. Source/reproduction data is untrusted input; proposed code executes only in its build environment. Build without real accounts, scheduling, production profile or publishing keys. QA runs relevant behavior tests plus conformance/permission guards and real Electron smoke. Capture user-visible preview/screenshots and a source diff. Hold validation policy/critical baseline tests outside agent-writable candidate source, so deleting a test cannot make the gate pass.
4. **Choose destination.** User scope creates a versioned local package and shows the concrete local change/capability diff. Official scope creates a source proposal/PR and reproducible candidate build; review/signing/release is a distinct authority. User prompt authorization may cover local activation under an established policy; the architecture should support activation controls rather than impose unnecessary repeated approval. Shared official publication does not follow automatically from one user's customization request.
5. **Stage activation.** Save a pending activation intent, expected old generation and candidate digest. Finish/cancel/checkpoint affected jobs, prevent new conflicting jobs, and reconcile uncertain effects before switching. Prepare consistent state backup. Activate via a generation pointer/binding transaction, not file edits in the installed archive. Compare-and-swap against the recorded old generation; if someone changed the base, revalidate/rebase. A crash between switching and recording success is reconciled by inspecting the active pointer/hash.
6. **Observe and accept or restore.** Parent/repair host checks launch, engine ready, schema/config compatibility, extension handshake, minimal query/tool health, renderer errors and a short failure window. Health checks are host-owned. During probation prevent externally visible effects; this keeps immediate backup restoration tractable. If unhealthy, quarantine candidate and restore the prior generation without calling broken plugin hooks. Retain receipts and failed artifacts for diagnosis; show the reason.

**Recommendation: compact activation generation.**

```json
{
  "format": "midnight.activation",
  "version": 1,
  "generation": "generation-18",
  "previous": "generation-17",
  "officialBase": { "version": "0.5.0", "sourceCommit": "...", "digest": "sha256:..." },
  "extensions": { "user:installation-123/report-helper": "sha256:..." },
  "bindings": { "report.formatter": "user:installation-123/report-helper" },
  "expectedDataSchema": 12,
  "state": "probation",
  "activationIntentId": "act-..."
}
```

Do not give this example's schema number meaning; the actual schema is derived from the candidate. Keep a last-good pointer and minimal stable deployment log outside the ordinary app database/schema and user overlays. Existing mission/action storage remains the normal journal; a small recovery-controlled activation journal survives app-schema or engine failures and obeys its own single-owner lock. On restart, reconcile pending deployments by artifact/generation hash. Downloading/building a candidate can be retried; official release creation and activation have deterministic job/candidate identities. For unknown external effects, inspect the resulting state/provider receipt before retrying.

**Recommendation: recovery outside the candidate.** Add tray/startup “Start without customizations” and “Restore last working customization” before executable overlays. For official kernel failure, a launcher/repair helper or installer route outside the replaceable app version must restore an intact last-good official package or install a verified repair. The helper needs its own minimal diagnostics/state backup logic and cannot depend on the candidate engine opening its database. It should not require an AI/model/network connection to disable a plugin or restore a cached package. Recovery-helper changes themselves use the ordinary official release lane. Code signing, artifact digests and OS access boundaries protect genuine trusted packages; merely calling a same-user file immutable does not stop malicious same-account code from editing it.

**Recommendation: migration and rollback discipline.** A conversation checkpoint resumes reasoning; a code-generation rollback changes active artifacts; a state backup restores old data; none reverses an email/upload/file effect. Prefer plugin-private namespaced state and additive migrations with N/N-1 read compatibility. Never let plugins edit the core mission schema. Reject automatic activation when the old artifact cannot read candidate-migrated state unless an explicit migration/restore strategy exists. During later rollback, retain post-activation receipts and user work; blindly restoring an old full database can lose receipts and permit duplicated external actions. After accepted live use, incompatible state often calls for forward repair or export/reconciliation rather than restoring a stale snapshot.

**Recommendation: build/source availability.** Cache an optional development kit with exact source commit, tests, pinned Node/toolchain, native helper inputs, lockfile and vendor provenance, or use isolated remote builds. Source inside the packaged app is insufficient. For developer/owner use this repository first; for installed users ship/import local extension source independently and use hosted CI for official patches. The packaged executable cannot double as the Node build runner because RunAsNode is disabled. Keep signing/release credentials out of generated workspaces and validation CI; only a trusted release stage handles them.

### Gaps

- Last-good official binary swap/repair-helper packaging is absent from the inspected implementation; choosing Windows side-by-side package/launcher layout is a concrete implementation decision still required.
- No evidence supports claiming current smoke tests verify newly introduced plugin activation, rollback, state compatibility or change-job idempotency. Those are the specific meaningful new tests to add.
- Current README says builds are unsigned. The implemented same-publisher signature gate does not imply an already working signed automatic-release pipeline; signing/verified artifact distribution is still an operational prerequisite. [README](../../README.md), [signature gate](../../src/desktop/updater.mjs)

## What is the smallest useful rollout, and what does “everything a plugin” cost?

### Takeaway

Prove the complete change loop with one local extension and one official fix before extracting existing features wholesale. Design namespaces, official/user scope and recovery from the outset, then expand extension coverage based on real requests.

### Cited Findings

- Current skill loading already supports a supplied directory, rejects bad manifests without accepting them, and binds skills to known tools; this enables a modest declarative overlay pilot. [skills/registry.mjs](../../src/skills/registry.mjs)
- Current tools and runtime adapter already provide central seams; the existing version-pinned provenance/SBOM process supplies a starting point for candidate traceability. [tools/index.mjs](../../src/tools/index.mjs), [adapter.mjs](../../src/runtime/adapter.mjs), [ADR 0002](../../docs/adr/0002-dependencies.md)
- VS Code warns that custom webviews carry resource and UX cost and should be used only when native contribution APIs are inadequate. This supports schema-rendered contributions before arbitrary custom screens. [Webview guide](https://code.visualstudio.com/api/extension-guides/webview)

### Inferences

**Recommendation: three-step rollout, both scopes from day one.**

1. **Change jobs and recovery, with two proofs.** Introduce scoped request/durable job records, recorded source base, developer worktree runner, independent activation log and safe mode. Local proof: prompt creates/repairs a JSON skill or theme overlay, validates it, previews, activates and restores across restart; reject a broken candidate. Official proof: prompt diagnoses one reproducible current app bug, patches a worktree, runs targeted checks/smoke, and produces a previewed official proposal/candidate without publishing automatically. Add a builder kit/hosted-build path before advertising source repair to arbitrary installed users. A declarative overlay proof alone does not prove executable/core repair; the second proof matters.
2. **One executable extension seam and one rich panel.** Extract one pure tool/formatter or connector using existing registry boundaries, plus optional separate WebContentsView panel following current Apps patterns. Supply a small SDK/schema/examples, version pinning, crash quarantine, source retention and per-user storage. Demonstrate failure injection: bad package/activation, hanging host, process kill during pointer switch, restart, API mismatch, migration rejection, and correct last-good restore. Official built-ins and local variants use the same narrow API where practical. Keep backend trust explicit; no marketplace or arbitrary dependency installation.
3. **Expand seams and release operation.** Move frequently customized tools/adapters/workflows into official extensions as demand warrants; support local derived versions and promotion into official proposals. Finish installed-user builder distribution and independent official repair/update route, with overlay compatibility checks across official upgrades. Measure startup/memory and resource budgets before isolating every feature into its own process. Add broader sharing/discovery only when trusted installation, update policy and sandboxing are proven.

Success should be measurable: a user requests a useful change and sees it after activation/restart; a bad version cannot block repair controls; an official proposal has a reproducible patch and QA evidence; duplicate activation requests produce one active generation; unknown external effects are reconciled; and an official update preserves compatible local customization or disables it clearly without deleting it.

An owner developing on this machine can supply the source/toolchain and trust their local code more readily. A product with many installations needs clean separation between “my customization,” “propose a fix for everyone,” and “release authority.” Each user's overlay remains private by default; proposals exclude prompts, credentials, mission history and filesystem samples unless intentionally supplied. Production release signing is confined to a trusted stage. This is product architecture for the two requested scopes, not a reason to build a marketplace early.

### Gaps

- Exact implementation size/timeline is not established. This research supports architecture and ordered acceptance gates, not reliable day/week estimates.
- Future requests may expose additional necessary contribution APIs. Avoid claiming that the initial contract can support every conceivable app modification; core source changes remain the escape hatch.
