# Computer, browser, terminal, coding, and execution architecture

Research date: 2026-10-12. Scope: capability providers, policy and execution boundaries, concrete contracts, reliability, migration, and release gates. This is research and an implementation proposal, not evidence that the proposed system already exists or outperforms competitors. Official documentation and repository code were read; no live desktop, browser, terminal, or model benchmark was run. Numerical targets below are proposed release criteria, not measured results. Pi versus Oh My Pi runtime selection is covered by the other researcher.

## 1. What should Midnight keep, and what must the rebuild actually add?

### Takeaway

Keep Midnight's application-owned missions, policy broker, event journal, evidence, and user interface around a replaceable inference runtime. Add browser semantics, a real terminal/coding service, independently verified outcomes, and enforceable cancellation; a different coding-agent dependency alone provides none of these product guarantees.

### Cited Findings

- The current application registers only mission, file, work, connector, and Electron-shell tools. The Pi adapter receives the registered custom tool names. There is no registered PTY, generic terminal runner, code patch operation, LSP service, or repository worktree service in these files. The file named shell-tools means Electron-shell operations, not a command shell. [Tool registration](../../src/tools/index.mjs), [runtime adapter](../../src/runtime/adapter.mjs), [shell tools](../../src/tools/shell-tools.mjs).
- Existing browser windows are per mission, but all use the same persistent partition, `persist:midnight-browser`. A three-window cap evicts the oldest window; separate windows therefore do not establish separate authenticated-account or server-side-state isolation. [Browser owner](../../src/desktop/browsers.mjs).
- Browser actions are coordinates, text insertion, keyboard events, `innerText`, and screenshots. A cookie-name heuristic produces only a probable sign-in verdict. `browserTool.execute` does not accept/use the cancellation signal forwarded by its owner. [Browser implementation](../../src/tools/browser.mjs).
- Click/Enter classification probes DOM labels/forms and commit words; probe errors become `{}`. Typing and navigation are classified as `browser.navigate`. This class is both automatically permitted by modes and safe to retry in recovery. It cannot establish that typing, an arbitrary link, an autosaving field, or a custom button has no external effect. [Classification](../../src/tools/shell-tools.mjs), [effects](../../src/contracts/domain.mjs), [recovery](../../src/missions/coordinator.mjs).
- The broker records canonical intents and binds approvals to hashes, rechecks grants before dispatch, reserves tool calls, and reconciles uncertain external requests. However, an owned tool without `verify` defaults to `verified`. The foreign-tool gate records dispatch outside the normal owned-tool dispatch path, so budget, lock, lease, verification, and uncertain-error behavior are not automatically equivalent. [Broker](../../src/policy/broker.mjs).
- Runtime wrappers deliberately disable ambient skills, extensions, prompt templates, and context files and register a tool-call gate; this is useful existing containment of ambient configuration. A comment claiming coverage of nested tools is not itself proof that every third-party path invokes the gate. [Runtime adapter](../../src/runtime/adapter.mjs).
- UI Pause/Stop calls `mission.pause`; host operations call the coordinator; pause/cancel mark the mission stopped, then await runtime abort, then release the screen. Emergency stop revokes the lease first. Platform cancellation reaches an AbortController, but adapter code must actually observe it. [UI](../../src/ui/app.js), [host](../../src/runtime/host.mjs), [coordinator](../../src/missions/coordinator.mjs), [supervisor](../../src/desktop/supervisor.mjs).
- Screen leases have an epoch, expiry, background-idle check, and helper arm/disarm. The host-process `lease.acquire` sends only missionId, dropping background/title. The PowerShell helper checks the current epoch on each command but has no independent TTL in the reviewed dispatch loop. Long or stuck helper work and late revocation therefore require real fault injection, not just state tests. [Lease](../../src/windows/lease.mjs), [host-process bridge](../../src/runtime/host-process.mjs), [helper](../../src/tools/input-helper.ps1).
- Budget defaults mention dollars, tokens, calls, and wall minutes, but the enforced budget key list omits wall minutes. Model usage is recorded after the runtime run completes; the normal broker reserves one tool call. This is not a hard pre-dispatch cap on inference spending. [Budget implementation](../../src/resources/budget.mjs), [usage settlement](../../src/missions/coordinator.mjs).

### Inferences

**Decisions CAP-01 through CAP-05, proposed:**

1. Preserve the durable application domain; migrate incrementally behind interfaces instead of discarding the implementation. Existing journals, receipts, grants, evidence, and UI states represent product work independent of the chosen core.
2. Make the same broker-owned dispatcher execute native, MCP, deferred, nested, codemode, subagent, and scheduled effects. A hook may reject calls, but no external engine gets a privileged alternate execution route.
3. Split acknowledgement from verification for all tools. A successful mouse API call proves dispatch, not task completion. No verifier means `acknowledged` or `unverified`, never automatic `verified` for an effect. A purely computational result can have a deterministic verifier.
4. Replace one coarse effect class with a set of possible effects and data flows: `{readPaths, writePaths, networkOrigins, accountId, sendsData, changesRemoteState, desktopInput, credentialUse, irreversible}`. One operation may both read a file and transmit it. Unknown GUI intent is not assigned a harmless default.
5. Correct pause/cancel/takeover before adding more tool power: stop dispatch and revoke leases immediately, request abort, drain/kill bounded workers, reconcile in-flight effects, then report the achieved stop state. Never promise that Stop reverses a submitted remote request.

Preserve default visual theme, visible controls, and ordinary-language interaction. The user should not need to remember which engine, slash prefix, shell, or browser backend to choose. Advanced details remain available in the activity inspector.

### Gaps

- Current dependency-free tests do not establish the cancellation behavior of installed Pi internals, real browsers, PowerShell UIA, or cloud providers. Add a pinned integration probe for each advertised behavior.
- A model that omits a needed check can still lead to a weak completion definition. Product-owned acceptance checks must be added for known task types, independently of model-proposed checks.

## 2. Which browser provider and session architecture should we choose?

### Takeaway

Use the Playwright library as the primary managed-browser execution provider behind Midnight's own narrow action contract. Keep a separately consented bridge for the user's signed-in browser; treat Stagehand, browser-use, and DevTools tools as specialized optional components or evaluation comparators.

### Cited Findings

- Playwright locators perform actionability checks and auto-wait; click checks uniqueness, visibility, stability, event reception, and enabled state. Assertions can retry until an observable condition holds. These are mechanics, not proof of user-intent satisfaction. [Playwright auto-waiting](https://playwright.dev/docs/actionability).
- Playwright authentication state can contain cookies and headers sufficient to impersonate an account and should not be checked into repositories. Parallel tests that modify server-side state need distinct accounts. [Playwright authentication](https://playwright.dev/docs/auth).
- Playwright MCP can attach via CDP, a Playwright server, or its Chrome/Edge extension. Extension mode reuses an existing browser profile, tabs, sessions, and extensions. [Connecting to browsers](https://playwright.dev/mcp/configuration/browser-extension).
- Playwright MCP explicitly says it is not a security boundary. Its allowed/blocked origin options are not complete security controls and do not cover redirects. [Playwright MCP](https://github.com/microsoft/playwright-mcp).
- Stagehand provides `observe` action candidates, `act`, structured extraction, and action caching. Its documentation describes acting with supplied Playwright/Puppeteer pages and replaying cached actions without repeated model calls. [Stagehand act](https://docs.stagehand.dev/v3/basics/act).
- browser-use exposes browser profiles, storage state, domain restrictions, proxy controls, and local/remote browser settings. [Browser-use parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters).
- Chrome DevTools MCP supplies Chrome diagnostics, network/console inspection, screenshots, and performance traces. Usage metrics are enabled by default; opt-out and CrUX-disable settings exist. Its security guidance places input validation on the client and recommends OS isolation for full filesystem/network boundaries. [DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), [security](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/SECURITY.md).

### Inferences

**Decision CAP-06: browser ownership and packaging.** Start a dedicated managed Chromium through a pinned Playwright library worker, not through unrestricted remote-debugging exposure on the Electron application's main process. Package or download a versioned, hash-verified browser bundle with the release; keep app and browser compatibility in the release manifest. Preserve Electron as the application UI. Midnight's workspace shows the browser's current URL, session/account, action highlight, latest viewport, and a visible **Open browser / Take over** control. A live viewport transport is optional after its latency/interaction spike; a current screenshot plus the real headed browser is the first reliable delivery.

Do not give Playwright and Electron coordinate tools concurrent ownership of the same target. During migration, each mission chooses exactly one backend. If a CDP adapter to an existing WebContents is considered to avoid an extra Chromium download, treat it as a spike: prove correct frame handling, context ownership, signal cancellation, downloads, and Electron/Playwright version compatibility. Do not expose the privileged application renderer as a browser target. Managed Chromium is the default decision unless this spike demonstrates equal guarantees at materially lower packaging cost.

**Decision CAP-07: three explicit session kinds.**

| Session | Default behavior | Ownership and constraints |
|---|---|---|
| Public research | Ephemeral, unauthenticated, text extraction first; bounded parallel pages | No private profile, no password store, no automatic uploads; source URL and retrieved time recorded |
| Midnight managed | App-owned named profile; ephemeral by default, persistent only when user names/signs into it | Profiles separated by identity; per-mission pages/contexts; one mutation writer per profile/account; explicit show, sign out, clear, export-policy controls |
| Your browser | User chooses profile/tab through supported extension/attachment flow | User retains cookies; no silent profile copying; bounded tab/origin access; direct user activity pauses the agent on that tab |

Existing `persist:midnight-browser` remains readable by the legacy backend during migration. Do not promise automatic cookie transfer into Playwright Chromium: Electron versions, OS encryption, profile format, and session policy can prevent safe transfer. Migrate profile labels and explain **Sign in once in the new browser** when needed. Do not dump cookies into prompts, logs, JSON manifests, or external providers.

**Decision CAP-08: execution strategy.** Use role/name/label or snapshot refs, strict matching, frames, and bounded actionability waits first; vision coordinates only for canvas/custom UI or inaccessible controls. Before a mutation, bind it to page/frame/origin, current observation, account, visible target, and authorized intent. Re-observe after navigation, modal changes, stale refs, account changes, and failed actionability. Use expected postconditions, not fixed sleeps, to decide completion. Do not automatically retry a possibly submitted request.

Authentication detection should inspect a site adapter's known account indicator or ask for human sign-in, not infer identity from cookie names. MFA, CAPTCHA, hardware-key, password-manager, and ambiguous account selection become visible handoffs. Do not make the model handle secrets simply because a framework example does.

Downloads become content-addressed artifacts in quarantine/staging with source URL, MIME, size, hash, initiating action, and completion/failure state. Reject traversal and unsafe filenames; never execute a download automatically. Upload binds an approved file revision/hash and destination/account; changing either invalidates approval. Handle popup tabs, cross-origin frames, dialogs, file choosers, redirects, service workers, new windows, and network failures explicitly. A domain allowlist alone does not control all egress.

**Decision CAP-09: do not install all browser frameworks.** Keep Playwright MCP extension as the first existing-user-browser bridge candidate. Add Chrome DevTools MCP only for debugging/performance tasks in a reviewed pack, with telemetry and CrUX calls disabled unless the user opts in. Evaluate Stagehand for extraction/action selection or reusable routines after the base provider works; any model-generated candidates still enter Midnight's broker. Browser-use is a strong browser-specialist comparator, not a second autonomous loop inside every mission. Compare all on identical tasks/models/budgets before promoting a component.

### Gaps

- Extension licensing, store distribution, tab selection UX, permission scope, pairing, update compatibility, and browser support need a packaging spike against pinned versions.
- Identity separation and session import need tests with at least two accounts on the same site. Separate tabs do not isolate account state.
- Chromium bundle size/startup overhead, Electron viewport embedding feasibility, and managed-browser persistence are experiments, not settled implementation details.

## 3. How should desktop computer use work across platforms?

### Takeaway

Ship Windows desktop capability first, using native accessibility actions plus observed screenshots as a fallback, under a small replaceable native worker. Browser, file, and coding features can become cross-platform earlier; do not claim full desktop parity until each OS passes its own workflow and interruption gates.

### Cited Findings

- Windows UI Automation is constrained by integrity levels; UIAccess has signing/install requirements and is intended for assistive technologies, not an unrestricted elevation shortcut. [Microsoft UIA security](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview).
- Apple AXUIElement represents an application's accessible elements, properties, actions, and notifications. [Apple AXUIElement](https://developer.apple.com/documentation/applicationservices/axuielement).
- Linux AT-SPI exposes the Assistive Technology Service Provider Interface. Wayland's RemoteDesktop portal creates sessions, selects devices, and presents user consent on Start; ScreenCast integrates through the same session. [AT-SPI](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/), [XDG RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html).
- Official OpenAI documentation describes both structured computer actions and code execution against an application-provided environment. The environment must preserve session state and enforce execution/permission limits; screen and document content are untrusted. [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use?lang=javascript).
- Anthropic describes client-side computer execution, screenshot processing, screenshot scaling, and prompt-injection exposure; its provider protections do not eliminate environment isolation or user-control responsibilities. [Anthropic computer use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
- Cua currently offers drivers, sandbox/fleet tooling, and benchmarks while allowing bring-your-own agents/models. Its repository flags deprecated components, including a security warning for cuabot. [Cua repository](https://github.com/trycua/cua).
- OmniParser converts screenshots into structured elements; UI-TARS/Agent TARS provide multimodal desktop/browser approaches and hybrid DOM/vision references. These are component/stack options, not evidence that Midnight would inherit benchmark performance by installing them. [OmniParser](https://github.com/microsoft/OmniParser), [UI-TARS](https://github.com/bytedance/UI-TARS-desktop).

### Inferences

**Decision CAP-10: Windows worker.** Implement a signed native helper in a language with mature Windows API bindings (C#/.NET is the default proposal for UIA/COM interoperability; validate deployment size/startup before locking it). Preserve the existing helper behind the same interface for regression comparison, not as an indefinitely parallel controller. Provide `listWindows`, `observe`, `invoke`, `setValue`, `select`, `scroll`, `capture`, and bounded input fallback. Prefer actual UIA Invoke/Value/Selection patterns where valid; the current click-element operation resolves a rectangle then physically clicks. UIA providers can be missing or hang: use time limits, bounded tree depth, response size caps, worker isolation, and restart.

Every operation binds process identity, window handle plus creation identity, display topology version, observation, and lease epoch. Revalidate focus before typing and revalidate target bounds immediately before pointer input. Reject stale snapshots and ambiguous controls. Semantic actions still need scope authorization: an Invoke on **Send** is consequential.

**Decision CAP-11: coordinate correctness is a contract.** A screenshot result includes observationId, capture time, displayId, native pixel bounds, virtual-desktop origin (possibly negative), image width/height, crop bounds, rotation, per-monitor DPI/scale, and an explicit image-to-desktop affine transform. Each coordinate action cites the observationId and image coordinates. The worker maps through the stored transform, validates that display topology/window geometry are unchanged, and rejects an out-of-bounds or stale action. Cropped zooms receive their own transform; never rely on one global `lastScale`. Test 100/125/150/200 percent scaling, mixed DPI, monitor left/up of primary, rotation, moving windows across screens, RDP transitions, and disconnected displays.

**Decision CAP-12: takeover.** Maintain a single global desktop input lease, short per-action leases, a native monotonic expiry watchdog, bounded input batches, and release on user takeover, session lock, suspend, display/session change, worker crash, or lost heartbeat. Check cancellation between input primitives. Background tasks may request desktop access only under an explicit unattended policy in an interactive unlocked session and after idle checks; preferably run unattended GUI jobs in a dedicated VM. Headless terminal/managed-browser work can continue without a desktop. Locked, secure, inaccessible, elevated, and permission-denied desktops return explicit unavailable/handoff states. Screenshot fallback cannot bypass OS input restrictions.

Use visible **Take over / Pause / Resume** buttons; one discoverable emergency shortcut may remain. Automating an application's existing keyboard shortcut is different from asking the user to memorize Midnight shortcuts; agent key actions remain available when they are the reliable app interaction method.

**Decision CAP-13: platform phasing.** Windows 11 x64 is the first full desktop target; include currently supported Windows variants only after compatibility tests. macOS follows with AX + screen capture + event input and first-run system permission UX, signed/notarized packaging, Retina transforms, and permission-revocation tests. Linux follows with explicitly tested GNOME/KDE Wayland portal backends and AT-SPI; X11 may be separately supported with disclosed weaker session isolation. Do not silently use X11 automation on Wayland. Remote sandbox drivers (Cua candidate) are optional later providers under the same contract, not prerequisites for using the person's local computer.

OmniParser or UI-TARS may improve fallback grounding, but add GPU/download/licensing/latency costs. Select only after demonstrating statistically useful gains over the baseline on inaccessible/custom UI tasks. Pin code and model-weight licenses separately.

### Gaps

- Apple documentation was partially JS-rendered in this research environment; exact ScreenCaptureKit/CGEvent entitlement and permission sequences must be validated in a macOS implementation spike.
- Desktop automation under RDP disconnect, fast user switching, elevated windows, game/graphics surfaces, and different Wayland compositors cannot be promised without platform tests.
- Native helper language and packaging are provisional engineering choices; the provider contract and stop/coordinate invariants are required regardless of language.

## 4. What constitutes real terminal and coding support?

### Takeaway

Build a persistent, cancellable command service and repository workspace service, not a chat tool that runs arbitrary strings in Electron main. Use node-pty for interactive terminals, a structured executable/argument path for ordinary commands, Git worktrees for change isolation, and read-only LSP intelligence before advanced refactoring.

### Cited Findings

- node-pty supports Windows through ConPTY, macOS, and Linux, and exposes spawn/write/resize/data operations. Its children run with the parent's permissions; the library is not a sandbox and is not thread-safe. [node-pty](https://github.com/microsoft/node-pty).
- Windows Job Objects manage process groups and can terminate associated children; ordinary process termination does not automatically terminate all child processes. [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [process termination](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process).
- Git worktrees provide additional working trees sharing a repository. [git-worktree](https://git-scm.com/docs/git-worktree).
- LSP standardizes language intelligence between editors and language servers. [LSP overview](https://microsoft.github.io/language-server-protocol/overviews/lsp/overview/).
- Anthropic sandbox-runtime documents macOS sandbox-exec, Linux bubblewrap, and Windows alpha with a dedicated local account, WFP network fencing and filesystem ACLs; Windows installation needs one-time elevation. Its platform caveats must be validated against the pinned release. [sandbox-runtime](https://github.com/anthropics/sandbox-runtime).

### Inferences

**Decision CAP-14: execution service.** Use a separate process for node-pty and process supervision, with bounded stdout/stderr spool files, UTF-8/encoding handling, terminal dimensions, input/output sequence numbers, deadlines, reconnect cursor, and redacted previews. For noninteractive work, call an executable plus argv and explicit cwd/env without a shell. For shell syntax, require an explicit shell identity and show exact script content. PowerShell, cmd, Bash, and zsh have distinct quoting and exit semantics. Do not infer success by parsing a prompt or an echoed sentinel alone.

Return a session handle for long commands; provide poll/attach, send-input, resize, interrupt, terminate-tree, and close. Pause blocks new commands and revokes input grants; it does not pretend a suspended terminal equals a safe paused mission. Cancel requests graceful interruption, waits a bounded interval, kills the owned process group/job, verifies child exit, and records uncertain external effects. Detect commands that spawn services; register their PID identity, ports, ownership, lifecycle, and explicit keep-running decision. Never kill unrelated user processes by process-name matching.

**Decision CAP-15: two execution levels, honestly labeled.**

- **Workspace sandbox:** default for generated code, builds, tests, untrusted repositories, downloads, and package scripts. Enforce filesystem, network, env-secret, process, and resource limits through a verified OS sandbox or VM/container backend. A workspace path check or worktree alone is not a sandbox. Disable ambient agent auth, browser profiles, clipboard, desktop access, Docker sockets, and cloud credentials by default. Package installation is networked code execution and goes through this boundary too.
- **On your computer:** necessary for approved native workflows and tools that cannot run in isolation. It has broker-enforced scope, logging, process ownership, and revocable authority, but is not claimed to constrain arbitrary child-process effects at OS level. Present the concrete requested command/roots/network scope. Offer a managed VM as a stronger optional execution location. Do not make installing an alpha sandbox a condition of all desktop use.

Windows native sandbox choice is a release-blocking spike for unattended generated code: compare pinned sandbox-runtime alpha, a properly isolated VM backend, and other supported Windows isolation choices using escape/compatibility tests. No silently weakened fallback. A default trusted native command mode may be released for explicit user commands with honest labeling while autonomous untrusted execution remains gated.

Windows file operations use canonical absolute paths, handle/reparse-aware containment checks, UNC/junction cases, and PowerShell LiteralPath APIs where shell operations are unavoidable. Never enumerate in one shell and delete in another. Use same-volume atomic writes, temp files, preimage hashes, and backups/trash for reversible replacement. Never generate recursive deletes from unchecked computed paths. Capture real exit code and binary/argv/cwd in receipts.

**Decision CAP-16: coding workspace.** Select a repository; record dirty/untracked state and base revision; use a dedicated worktree per autonomous mutating task when feasible. Preserve existing user changes. Worktrees share Git metadata, so operations affecting refs/config/index need explicit ownership and serialization. For non-Git projects use a controlled staged workspace plus a manifest.

Expose file listing, bounded read, rg search, precise patch application with expected preimage hashes, diff/stat, diagnostics, tests, and artifact publishing. Publish a patch back with conflict detection and a reviewable diff, not a blind directory copy or reset. Ship TypeScript/JavaScript and Python diagnostics first; discover/configure LSP servers without silently executing arbitrary project hooks. Add broader languages as tested packs. LSP rename/workspace edits are previews routed through patch policy; never a write bypass.

A completed code task includes changed-file diff, tests actually executed with exit codes and logs, environment/dependency versions, known failures, and optional browser UI verification. Existing tests are not sufficient if unrelated to the task; generated tests are not the only ground truth. Commits, pushes, PRs, merges, deployments, and package publishing are distinct actions with their own prior user authority. Retain a one-click **Review changes / Run checks / Open project** flow rather than requiring terminal expertise.

### Gaps

- Electron ABI/native module packaging, ConPTY cancellation, signal delivery, long output/backpressure, interactive prompts, encodings, and WSL integration require pinned Windows/macOS/Linux probes.
- A cross-platform sandbox provider is not chosen solely from README claims; local filesystem/network escape tests and startup/install UX must decide it.

## 5. What contracts, trust boundaries, and persistence should be implemented?

### Takeaway

One application-owned effect protocol should connect the runtime, tools, UI, scheduler, and verification. MCP is the tool integration boundary; ACP is an optional external-agent/client boundary. Neither protocol provides OS isolation or durable exactly-once effects by itself.

### Cited Findings

- ACP requires initialization/capability negotiation before sessions, allows session MCP configuration, and defines cancellation and permission responses. Cancellation should stop model/tool work and return a cancelled stop reason after abort completes. [ACP setup](https://agentclientprotocol.com/protocol/v1/session-setup), [ACP prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn).
- MCP security guidance discusses confused-deputy attacks, SSRF, session hijacking, token audience checks, and forbids token passthrough. [MCP security](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).
- LangGraph separates thread checkpoints and long-term stores and supports recovery/human-in-the-loop persistence. This is a useful design reference, not a reason to layer a second state owner over Midnight. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence).
- Midnight already stores an event envelope, action lifecycle, mission lifecycle, trusted grant origins, and hash-bound approvals. [Events](../../src/contracts/events.mjs), [domain](../../src/contracts/domain.mjs), [grants](../../src/policy/grants.mjs), [approvals](../../src/policy/approvals.mjs).

### Inferences

**Decision CAP-17: proposed contracts, versioned independently of the chosen runtime.**

`RuntimeAdapter.start/continue/steer/cancel/getCapabilities` emits `message.delta`, `tool.proposed`, `usage.delta`, `compaction.completed`, `turn.settled`, and `runtime.failed`. It does not directly execute effects or declare mission success. All event payloads are runtime-validated at process boundaries.

`CapabilityProvider.describe/prepare/execute/observe/reconcile/cancel/health` accepts a broker-issued execution ticket. `prepare` produces a canonical action with typed effect set, resources, observation bindings, data destinations, argument/content hashes, expected postconditions, reversibility, and retry category. `execute` accepts a deadline, budget reservation, lease epoch where applicable, cancellation handle, and idempotency key. Providers reject tickets for other missions/capabilities or stale policy versions.

Suggested public tool names and minimum arguments:

| Namespace | Operations | Essential contract |
|---|---|---|
| browser | sessions, open, observe, act, extract, wait, download, upload, close | sessionId, tabId/frameId, observationId, target ref or typed locator, action payload, expected origin/account, expected postcondition |
| desktop | status, windows, observe, act, capture, release | sessionId, process/window identity, displayId/topologyVersion, observationId, leaseEpoch, semantic action or image point, expected focus |
| terminal | start, poll, write, resize, interrupt, terminate, close | workspaceId, executionProfileId, executable+argv OR explicit shell+script, cwd, env references, deadline, processSessionId, stream cursor |
| code | search, read, patch, diagnostics, diff, test, worktree, publish | workspaceId, expected file hashes/base revision, patch artifact, command profile, structured test/diagnostic results |
| files/artifacts | read, convert, stage, validate, publish, reveal | rootId and relative path, input revision, format, source evidence, output hash, validation results |
| integrations | discover, connect, call, status, disconnect | serverId/version, accountId, operation schema, scoped auth reference, destination, idempotency/reconciliation support |

Use a small tool catalog and lazy discovery by task; keep provider-specific schemas internal. Model-produced code may compose allowed tool calls through a capability facade, but must not import filesystem/network/child-process libraries from the privileged host. Pure data transforms can run in an isolated runtime with time/memory caps; actual effects still receive separate tickets and receipts.

Extend the existing `MidnightEvent` envelope with `schemaVersion`, `id`, monotonic `seq`, `missionId`, `runId`, `turnId`, `actionId`, `parentActionId`, `correlationId`, `occurredAt`, `source`, and typed `payload`. Distinguish persisted facts from ephemeral text/viewport streams. Add `capability.requested/granted/revoked`, `observation.recorded`, `process.started/exited`, `cancellation.requested/acknowledged`, `action.acknowledged/verified/unknown`, and `handoff.requested/completed`. Replay updates UI state only; it never re-executes a tool.

Store migrations add `capability_grants`, `execution_tickets`, `observations`, `process_sessions`, `browser_profiles`, `workspace_snapshots`, `provider_versions`, and `evaluation_runs`, or extend existing equivalent tables. Keep one SQLite authority for local state with transactional journal/outbox writes. Large screenshots, traces, terminal logs, and artifacts live in a content-addressed blob store with references, retention class, byte size, hashes, and deletion accounting. Secrets remain in OS-backed credential storage; action journals use opaque credential references and redacted display values. Exportable receipts contain provenance, not credentials.

**Decision CAP-18: action lifecycle.** `proposed -> prepared -> authorized -> dispatched -> acknowledged -> verified`; uncertainty leads to `unknown -> reconcile`, not automatic retry. Store the intent and execution ticket before dispatch. Connectors use service idempotency keys where supported and reconcile with service-generated identifiers; otherwise query independent state before retry. Desktop clicks and shell scripts are not inherently idempotent. After a crash, observation refs, native leases, browser selections, and stale consent are invalidated; regenerate a current proposal where necessary. Database replay does not guarantee exactly-once external delivery.

**Decision CAP-19: authority and reduced friction.** Prior user authorization persists as scoped grants bound to resource, account, origin, operation, data class, expiry, and limits. Do not ask twice for the same authorized work. Persist one-time decisions enough to survive reconnect but do not widen them into standing authority. A visible rule editor explains future reuse and revocation. A concrete action preview shows recipient/destination, changed records/files, attachments, and consequence; permission is independent of whether the model has already written a plan. Bundle related reversible actions under scoped intent when safe. Revoke and recheck authority at dispatch, not only when the plan was approved.

**Decision CAP-20: untrusted content.** Web pages, screenshots, documents, tool outputs, repository instructions, imported skills, and memory candidates are data with provenance and trust labels. They cannot grant authority or select their own sandbox policy. Trusted user requests/policy are separate from retrieved instructions. Redact secrets before model transmission and before durable logging, with user-accessible preview of what will be shared where practicable. Preserve source labels through summarization/compaction. Treat tool annotations as hints; pin reviewed schemas/versions and re-review changed permissions.

Enforce filesystem and network restrictions in actual worker environments when claiming isolation. Browser URL checks, roots lists, shell regexes, prompt warnings, and a successful approval are separate controls, not substitutes for OS/network enforcement. Test localhost/private-network redirects, DNS rebinding, proxy bypass, WebSocket/UDP paths, symlinks/junctions, executable child processes, and credential access according to the selected backend. Deny unsupported capability combinations rather than silently broadening them.

**Decision CAP-21: scheduling, budgets, and recovery.** Scheduled routines need an explicit timezone, misfire policy, recurrence key, maximum concurrency, deadline, known inputs/account, resource limits, and action authority. No catch-up duplicate sends after sleep or clock/DST changes. Revalidate recipe/tool versions on every run. Unattended first release supports research, drafts, code in a verified sandbox, and idempotent connector operations; local GUI automation needs additional attended/unlocked/idle constraints or a dedicated VM. Offline and local-model-plus-network modes must be separate consistently enforced choices.

Reserve inference budget before each model call, including retries, subagents, summaries, verifiers, image tokens, and specialized browser models. Set output caps and bounded in-flight reservations; settle actual cost afterward. Unknown subscription cost is unknown, not zero; use calls/tokens/time limits in addition. Enforce wall time using monotonic deadlines. A hard dollar cap cannot be advertised if the provider price or worst-case usage is unknown. Child agents share the mission budget and cannot expand it. Permit independent reads in parallel; serialize same-account writes, same-worktree writes, and global desktop input.

MCP server processes get explicit environment allowlists, pinned executable identities, timeouts, output caps, and network/file profiles. Remote OAuth uses proper audience/scope and per-account token storage; no generic token passthrough. ACP support is phase-later interoperability: negotiate terminal/filesystem authority and route requests through the same broker; external agents that self-execute outside those controls are labeled as separate execution environments, not falsely claimed to be fully mediated.

### Gaps

- This proposed envelope is not a drop-in upstream Pi/Oh My Pi/MCP schema; adapters and compatibility tests are required.
- Browser/desktop effect classification is inherently incomplete on arbitrary UI. Reliable scopes, user handoff, and verified postconditions reduce risk but cannot prove that all GUI actions are harmless or intended.

## 6. How do files, research, artifacts, connectors, memory, and skills fit?

### Takeaway

These are core product capabilities with the same execution and evidence contract; they should not be left as unreviewed shell scripts. Deliver a bounded set well before claiming that Midnight can do everything.

### Cited Findings

- Existing work tools read CSV/XLSX, expose cached formula results without recalculation, calculate through a restricted arithmetic parser, stage bar-chart SVG/CSV and DOCX/Markdown, and perform structural validation. Structural validation does not prove report correctness or rendered layout quality. [Work tools](../../src/tools/work.mjs).
- Skill packs are reviewed JSON manifests that reject install/scripts/exec/grants fields; recipes derive from verified missions and exclude desktop effects. This is a useful distinction between guidance and authority. [Skill/recipe registry](../../src/skills/registry.mjs).
- Connector registry and demo implementations exist; they are not evidence that production accounts, OAuth, rate limits, or all service write/reconciliation paths work. [Connector registry](../../src/connectors/registry.mjs), [demo connector](../../src/connectors/demo.mjs).

### Inferences

**Decision CAP-22: deliverable scope.**

1. Local file search/read/write/move: permission-selected roots, stable metadata, content hashes, undo manifests, conflict detection, preview/publish. Parse documents in bounded workers with archive-size/decompression/time limits.
2. Research: keep fast public text reading; add search-provider adapter with source URL/title/retrieval timestamp and content hash; separate facts from extracted instructions. Cache by content/context, respect freshness needs, and expose blocked/failed sources. A cited URL must actually have been read; citation existence alone does not prove claim support. Add supported-claim sampling or evidence mapping.
3. Documents: first ensure Markdown, CSV/XLSX reading, DOCX writing, PDF extraction/OCR and faithful preview/export; add editable spreadsheet authoring/recalculation and PPTX generation in staged increments. Display unsupported formula/font/layout situations. Parse-back, rendered previews, page/slide clipping checks, and independent sample verification accompany publish. Avoid pretending hand-written minimal ZIP/XML generators provide full Office fidelity.
4. Connectors: choose one production workflow first (e.g. read calendar and draft email), implement OAuth/scopes/disconnect, paginated reads, rate limits, schema validation, retries, per-account locking, draft preview, idempotency and read-back. Expand after real account tests. Sending/publishing is a separately authorized step. Do not ship demo CRM data as a live capability.
5. Skills: signed or hash-pinned reviewed manifests with required tools, effects, network roots, schemas, tests, expected outputs, version and license. Instructions never grant authority. If executable scripts are added, they run through terminal/code capability and sandbox, not directly at load.
6. Memory: user-editable facts/preferences with source, confidence, scope, created/updated time, expiry, deletion, and conflict handling. Never store secrets or permissions as informal memory. Distinguish a suggested preference from an active rule.
7. Artifacts: immutable revisions, source evidence, validation status, previews, download/open/reveal, and controlled publication. Actions on an artifact bind its revision/hash; edits invalidate approvals for sending that artifact.

### Gaps

- Production connector selection depends on actual user workflows and account access. Scope a first vertical slice, not a speculative marketplace of untested adapters.
- PDF/Office libraries, renderers, licenses, and platform dependencies need specific component evaluations before selecting an implementation.

## 7. What phases and evidence justify release?

### Takeaway

Build and measure complete vertical workflows before expanding providers. Release claims should report task success, unsafe/unintended actions, takeover, recovery, latency, cost, and accessibility outcomes separately; a passing mocked unit suite is insufficient.

### Cited Findings

- OSWorld provides execution-oriented real-computer tasks and an external evaluation process, with explicit reporting for unavailable task subsets. [OSWorld](https://osworld-v1.xlang.ai/).
- BrowserGym supplies browser-task environments. SWE-bench evaluates software issue resolution; Terminal-Bench addresses command-line tasks. None alone covers the entire Midnight product. [BrowserGym](https://github.com/ServiceNow/BrowserGym), [SWE-bench](https://www.swebench.com/), [Terminal-Bench](https://www.tbench.ai/).
- The repository's current eval runner deliberately does not execute real browser/desktop tooling; it is useful for its declared scope, not proof of desktop/browser excellence. [Evaluation runner](../../evals/run.mjs).

### Inferences

**Decision CAP-23: dependency-gated roadmap.** These are capability work packages for the main rebuild plan; estimates and owners should be added after spikes, not invented from research.

| Phase | Deliverable and reason | Dependencies | Required acceptance evidence |
|---|---|---|---|
| 0. Freeze baseline and reproduce | Record shipped tool surface, sessions, user data, current tests, policy gaps, performance, and release hashes; reproduce highest-risk bugs | None | Current app workflows captured with independent final-state checks; restart/stop/budget cases reproduced; no production-data mutation |
| 1. Execution foundation | Common provider/ticket contracts, true acknowledged/verified distinction, uniform dispatcher, pre-call budgets, cancellation and worker supervision | 0; chosen runtime adapter | Native/foreign/nested/scheduled calls cannot bypass policy; crash and revocation tests at every dispatch boundary; no new effects after stop acknowledgement |
| 2. Browser vertical slice | Pinned Playwright managed browser, snapshot refs, text/screenshot evidence, session/account ownership, upload/download, visible takeover | 1 | Search -> signed-in test site -> download -> local artifact -> prepare submission; MFA handoff; popups/iframes; stale ref rejection; no duplicate commit after injected timeout |
| 3. Terminal and coding | Process/PTY service, workspace sandbox spike, worktrees, patch/diff, TS/Python diagnostics, tests, local preview | 1; sandbox decision | Bugfix -> meaningful tests -> browser verification -> reviewable diff; dirty-tree preservation; package script containment; child-process termination and resource limits |
| 4. Windows desktop vertical slice | Native UIA patterns, vision fallback, transforms, immediate takeover, locked/elevated states, native watchdog | 1; browser/terminal interfaces reusable | Browser file -> desktop app -> editable document -> verified export; mixed DPI/multiple monitors; focus theft; lock/suspend; inaccessible UI; cancellation during input |
| 5. Product workflows | Production connector, files/artifacts validation, skills/recipes, memory, scoped standing grants and safe scheduling | 2–4 as needed | Real test-account workflow with independent receipt; timezone/sleep/retry behavior; artifact correctness; permission revocation; no duplicate scheduled effect |
| 6. Cross-platform and interoperability | macOS then tested Linux desktop providers; optional user-browser bridge, MCP packs and ACP agents | 1–5; platform probes | Per-platform published capability matrix and target suites; permission onboarding/revocation; MCP/ACP conformance and policy mediation |
| 7. Release and continuous evaluation | Signed release, staged rollout, migration/rollback, defect monitoring, pinned upgrade canaries | All advertised capabilities pass | Clean-install/upgrade/rollback on supported OS; integrity/license manifests; no unresolved critical trust/cancellation/migration failures; holdout workflow gate |

Phases 2, 3, and the Windows prototype in 4 can be parallelized after phase 1 contracts settle. Do not wait for macOS/Linux full desktop parity to improve Windows, but keep unavailable capabilities explicit. Do not introduce LangGraph/Temporal just to get a second durable state store; reconsider a distributed workflow engine only if hosted multi-machine operations exceed the local coordinator's responsibilities.

**Decision CAP-24: proposed evaluation program.**

- Build 100 representative product scenarios: 25 browser, 20 desktop, 20 terminal/coding, 15 file/research/artifact, 10 connector/scheduled, 10 multi-surface workflows. At least 30 are holdouts maintained independently of agent prompts; run five seeds per scenario/configuration for comparisons. Expand by platform and account/session type, and report sample size and confidence intervals. Do not treat repeated variants as independent users.
- Use independent ground truth: test-site server state, mail sandbox delivery IDs, filesystem hashes/content, spreadsheet values, repository tests written independently of generated patches, process trees, and application output. Agent self-report is not a grader. LLM judges may score prose/presentation alongside blinded human review, never alone for consequential action correctness.
- Compare current Midnight and candidate engines/providers with pinned versions, identical tasks, models, task budgets, hardware/OS, tool permissions, and allowed human help. Report pass@1 and repeat-run success, not a cherry-picked best of many runs. Include at least one alternative browser specialist and desktop driver only on comparable tasks. Keep external benchmark scores separate from product suite scores.
- Measure completed task rate, required human interventions, false-success rate, unintended side effects, incorrect approval reuse, uncertain-effect reconciliation, duplicate sends/writes, first useful result time, total and p50/p95 latency, tool/model calls, tokens/image bytes, peak RAM/CPU, startup time, actual and unknown cost, dollars per independently successful task, and cancellation/takeover latency.
- Adversarial/fault cases: injected document/web/image instructions, malicious MCP annotations, exfiltration URLs, authorization revocation during a wait, token expiry, wrong signed-in account, stale locators/windows, large output, failed downloads, profile busy, disk full, native helper hang, worker/model/network crash, rate limits, schema changes, repeated response delivery, suspend/lock, user typing, and changed files after approval.
- **Proposed gates:** 100% policy/contract invariant tests; zero observed unauthorized consequential effects or duplicate external commits in the release suite; at least 90% independent task success on the supported curated suite with no domain below 80%; false-success under 1%; no success regression versus baseline beyond two percentage points without a reviewed reason. These are release ambitions to calibrate after the baseline, not evidence of safety or performance. With only 500 runs, an under-1% false-success estimate remains statistically coarse; publish intervals and add volume for high-risk gates.
- **Proposed responsiveness goals:** takeover acknowledgement p95 under 250 ms and no later input from revoked epochs; owned process tree termination p95 under 2 s after the configured graceful window; first local UI feedback under 100 ms; no p95 end-to-end latency/cost regression over 20% absent a measured success benefit. Hardware and event-boundary definitions must be recorded before these numbers become enforceable service objectives.
- Run fast deterministic contracts per change, pinned integration suites per adapter change, real workflow suites nightly/weekly as budget permits, and holdout plus migration/rollback suites before release. A refusal that correctly protects authority is scored separately from successful task completion; do not inflate task success with safe failures.

**Decision CAP-25: migration and rollback.** Add new providers behind capability flags and per-mission routing. Preserve existing mission/session IDs and append schema versions; keep old transcripts readable. Snapshot application data before migration, dry-run migrations on copies, and verify record counts/artifact hashes. Do not serialize provider SDK objects into canonical journal payloads. Migrate user settings/theme/selected roots and explicit rule meaning; do not silently broaden prior grants or re-enable revoked desktop control. Incompatible rules require visible re-review.

Roll back binaries only while data schemas remain backward-readable. Otherwise restore a validated snapshot and import/export later artifacts deliberately; never downgrade a live database blindly. Preserve uncertain-action receipts across rollback so old software cannot repeat a send. Release manifest pins runtime, native helpers, browser, MCP packs, schema versions, licenses, hashes, and signing identity. Stage rollout from internal fixtures to opt-in users to general availability; a kill switch disables a faulty provider without discarding mission history. Record sanitized crash/latency telemetry only under clear user controls.

**Decision CAP-26: experiments before irreversible architecture commitments.**

| Experiment | Success criterion / decision unlocked |
|---|---|
| Two runtime adapters with the same fake provider | Correct streaming, nested gating, cancel, resume, usage, image output; chooses core without coupling UI |
| Playwright managed Chromium versus existing WebContents CDP | Frames/downloads/cancel/profile separation and compatible packaging; resolves bundle/viewport tradeoff |
| User-browser extension pairing with two profiles | Correct tab/account scope, no cookie export, human takeover, clear failure recovery |
| Windows native sandbox versus VM | Files/network/child-process containment plus ordinary developer workflows; chooses default isolated executor |
| UIA worker versus current helper, mixed DPI | More independent task success without false clicks; bounded hang/cancel behavior; chooses helper packaging |
| Vision fallback: baseline versus OmniParser/UI-TARS | Statistically useful gains on inaccessible controls at acceptable latency/cost/license/runtime footprint |
| Crash after remote commit, before receipt | Reconciliation finds exactly what occurred, no automatic duplicate; validates durable action protocol |
| Migration/rollback with real-shaped data | Profiles, rules, artifacts, pending approvals, and unknown receipts remain recoverable and correctly scoped |

### Gaps

- Research cannot establish a universal best harness or exhaustive coverage of all future tasks. Publish capability boundaries and measured workload results instead.
- Native platform compatibility, credentials/subscription terms, model/tool support, actual costs, and framework versions change. Recheck sources and pin versions before implementation and release.
