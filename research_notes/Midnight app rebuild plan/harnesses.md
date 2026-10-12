# Harness research for Midnight rebuild

Research date: 2026-10-12, Asia/Kuala_Lumpur. Primary-source review plus local source inspection; no new runtime benchmark or package installation was performed. Recommendations below are architectural judgments, not measured comparative rankings. URLs using `main` describe the observed documentation/source and can move; release tags and the existing provenance manifest provide firmer version anchors.

## Which core should Midnight ship?

### Takeaway

**Recommended decision: retain upstream Pi coding-agent SDK as the one production engine, behind MidnightRuntimeAdapter, with Midnight owning the action broker, durable mission journal, permissions, workers, device leases, evaluation and UI.** Retain qualified 1.0.1 initially; run the same contract suite against upstream 1.1.0 before upgrading. Oh My Pi is the strongest challenger and feature reference, tested as an isolated Bun subprocess through its supported RPC, not imported as a presumed Node-compatible replacement.

### Cited Findings

- Current app is 0.2.2, Electron 44.4.5, with eight exact `@earendil-works/*` Pi packages at 1.0.1. Provenance records upstream registry origin, MIT licenses and SHA-512 integrity, packed 2026-10-03. ADR 0002 supersedes README/CLAUDE descriptions of the old fork workflow; it retains the former credential path explicitly, not through a forked package. [Local package manifest](C:/zsolusi/midnight.app/package.json); [provenance](C:/zsolusi/midnight.app/vendor/PROVENANCE.json); [ADR 0002](C:/zsolusi/midnight.app/docs/adr/0002-dependencies.md).
- `badlogic/pi-mono` redirects to **earendil-works/pi**. Current package namespace is `@earendil-works`, not the historical `@mariozechner`. Pi v1.1.0 release is dated October 7, abbreviated commit `abe508e`; tagged package manifest requires Node >=22.19.0 and specifies MIT. [Pi upstream](https://github.com/earendil-works/pi); [v1.1.0 release](https://github.com/earendil-works/pi/releases/tag/v1.1.0); [tagged manifest](https://raw.githubusercontent.com/earendil-works/pi/v1.1.0/packages/coding-agent/package.json).
- **Oh My Pi core is can1357/oh-my-pi**, maintained under Stencil Labs, package `@oh-my-pi/pi-coding-agent`. Its latest release page observed was v18.9.2 dated October 11, commit `bd4dffd`, with breaking changes in pi-ai described even in that patch release. A retrieved `main` coding-agent manifest showed 18.9.1 while natives showed 18.9.2; treat that mismatch as unresolved documentation/cache/artifact drift, not evidence of a faulty published package. [OMP upstream](https://github.com/can1357/oh-my-pi); [release](https://github.com/can1357/oh-my-pi/releases/tag/v18.9.2); [coding-agent manifest](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/package.json); [native manifest](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/natives/package.json).
- The similarly named Changhochien/oh-my-pi is a Pi orchestration/skills project, not the above engine. [Project README](https://github.com/Changhochien/oh-my-pi).
- Existing runtime ADR already compared experimental Pi Durable and coding-agent SDK on this machine on 2026-10-04. It records SDK interception of direct and nested tool calls; both engine approaches could repeat a model-requested external effect after recovery. The chosen SDK plus journal is already implemented in `src/runtime/adapter.mjs`, with discovery disabled and tools explicitly supplied. These are repository-recorded results, not new measurements from this research. [ADR 0001](C:/zsolusi/midnight.app/docs/adr/0001-runtime.md); [adapter](C:/zsolusi/midnight.app/src/runtime/adapter.mjs).
- Pi Durable's current README still labels its API experimental and changeable without notice. Its storage-first execution does not by itself establish exactly-once semantics for arbitrary external services. [Pi Durable README](https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/README.md); the external-effect limitation is demonstrated locally in [ADR 0001](C:/zsolusi/midnight.app/docs/adr/0001-runtime.md).

### Inferences

- Choosing Pi is a deliberate continuation of a useful foundation, not a requirement to preserve every present implementation. A rebuild should replace weak behavior around this core rather than repeat solved integration work.
- Prefer the coding-agent SDK to the lower-level agent-core alone: otherwise Midnight must rebuild session trees, context lifecycle and extension integration it already uses. Prefer it to experimental Durable until the latter passes the same policy and migration gates.
- Do not embed two competing coordinators, model-routing systems or journals. Keep a narrow replacement seam, but ship only one default engine. If OMP wins the declared test, replace the adapter; do not turn engine selection into another ordinary-user setting.
- Pi is not automatically superior at computer/browser work. The product's tool implementation, observation quality, authority boundaries, models and evaluations determine those outcomes.

### Gaps

- No independently controlled Pi-versus-OMP Windows desktop/browser benchmark was found or run. Neither popularity nor upstream marketing substantiates a “best” claim.
- Latest main documentation can be ahead of 1.0.1 or even 1.1.0. Exact package exports, signatures and artifact checksums must be captured in the qualification spike; do not paste current-main examples into the old pin without checking.

## What do Pi and Oh My Pi actually expose?

### Takeaway

Both offer a real headless integration surface. Pi is closer to Midnight's present Node/Electron architecture; OMP includes more ready-made workflows but also more runtime dependencies and implicit behavior that Midnight would have to constrain.

### Cited Findings

| Concern | Pi: observed capability | OMP: observed capability |
|---|---|---|
| Embedding | TypeScript SDK: `createAgentSession`, explicit session/settings/resource/model boundaries. | `createAgentSession`; root exports include SessionManager, AuthStorage, ModelRegistry. The narrower `/sdk` subpath does **not** export those three. |
| Run control | `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`; settlement differs from low-level run end. | Prompt steering/follow-up/aside, abort and asynchronous dispose; private AgentRegistry required for concurrent top-level sessions. |
| Streaming | Message, tool, queue, compaction, retry events; `message_end` finalizes text and `agent_settled` means no automatic continuation. | Event subscription, eventBus/subagentEventBus, extension UI bridge and host-facing session events. |
| Persistence | SessionManager owns branchable JSONL history and compacted model context. | SessionManager supports persistent JSONL and in-memory sessions, resume/list/fork. |
| UI | SDK separated from TUI; host controls presentation. | SDK and RPC can drive a custom host; TUI component factories are not portable RPC UI. |

Source for Pi cells: [Pi SDK](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md). Source for OMP cells: [OMP SDK](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/sdk.md) and [OMP RPC](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/rpc.md). These cells describe documented contracts, not successful execution in Midnight.

- Pi source accepts `modelRuntime`, `sessionManager`, `settingsManager`, `resourceLoader`, `customTools` and explicit active-tool configuration. Its default resource loader and default tools are used when not overridden; recent source's `noTools`/selection behavior requires care around still-registered MCP tools. [Pi session factory source](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/sdk.ts).
- Pi extensions can block or modify `tool_call`. Nested `ctx.executeTool` calls also undergo argument validation and tool hooks, and emit linked tool events. SDK MCP/codemode/tool-search extensions must be explicitly added and initialized; they are not implicitly loaded as in the CLI. [Pi extensions](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md); [Pi SDK](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md).
- Pi intentionally omits built-in subagents and plan mode, supports Windows installation, and explicitly says it has no built-in restriction boundary for files, processes, network or credentials. The README describes dependency pinning and installation without lifecycle scripts. [Pi README](https://raw.githubusercontent.com/earendil-works/pi/main/README.md).
- OMP coding-agent manifest requires Bun >=1.3.14. Native package describes Rust N-API bindings covering PTY, shell, search, clipboard, image, PDF/audio and WebRTC. This is substantive packaging scope, even though a prebuilt binary may make end-user installation simpler. [OMP package](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/package.json); [OMP natives](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/natives/package.json).
- OMP factory source imports browser/computer preludes, memory, discovery, model fallback, advisor and subagent modules; contains actual `Bun.env` use; provides `disableExtensionDiscovery` and `enableMCP` controls. The SDK describes default discovery of skills/context/extensions, enabled MCP/LSP, and some settings held process-wide by the newest top-level session. [OMP factory source](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/sdk.ts); [OMP SDK](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/sdk.md).
- OMP documents registry tool interception including built-in/custom/extension tools and advisor calls. This is useful evidence of a policy seam, but not proof that every browser prelude, arbitrary eval, subprocess or future plugin is confined. [OMP extensions](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md).
- OMP RPC is custom JSONL, not JSON-RPC 2.0. It supports host-owned custom tools/cancellation and lossless version-2 framing; large events require negotiated chunk reassembly. `waitForIdle` is not a settlement barrier. Its `--no-ui` approval path fails closed; ordinary `ask` timeout behavior can choose a recommended/default option, so this must never be repurposed as authorization. [OMP RPC](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/rpc.md).
- OMP README describes LSP, parallel review, subagents, content-hash edits, browser workflows and native Windows operation without WSL. Claims such as fewer edit tokens are author claims tied to specific examples, not transferable Midnight performance results. [OMP README](https://raw.githubusercontent.com/can1357/oh-my-pi/main/README.md).

### Inferences

- Use Pi in the existing Electron utility-process host, keeping the renderer and main shell responsive. A utility process is a fault boundary, **not an OS sandbox**. Restrict filesystem/process/network authority below the engine with worker isolation and capability-specific brokers.
- OMP's best comparison route is a pinned standalone/Bun child using supported RPC and host-owned broker tools. Do not try to load Bun-only modules directly into Electron's Node process. Audit artifact ABI/architecture and worker shutdown on Windows before considering it production-ready for Midnight.
- Disable ambient home/project plugin, executable credential-command and provider discovery in a packaged product. Allow reviewed resources through explicit manifests. Loading configuration is not harmless if it can import code, run commands or alter model endpoints.
- Keep one agent controlling a particular desktop/input lease. Parallelize read-only research and isolated coding workspaces; propagate per-child budgets and reduced permissions. Reuse broker APIs for every nested call, including programmatic-tool/codemode compositions.
- Borrow OMP ideas through narrow experiments: LSP diagnostics, content-hash preconditions, evidence-based reviews, native search/PTY and subagent output summaries. Avoid importing its UI, keybindings and full tool catalogue merely to gain one feature.
- Translate runtime events into Midnight's versioned mission events and typed artifacts. Engine settlement is only “the engine stopped”; completion requires app-owned task verification and effect receipts.

### Gaps

- OMP Windows support is documented by upstream, but packaged Electron interoperability, hardware support, install size, startup latency and native helper cancellation have not been measured here.
- Pi/OMP tooling hooks intercept registered calls; untrusted in-process extension code has process authority. Neither hook surface should be described as a security sandbox.

## Which other harnesses are materially relevant?

### Takeaway

This is a bounded comparison of plausible alternatives and useful references, not an exhaustive list of every agent project. A headless engine, client protocol, model API and browser/computer driver are different layers and should not be ranked as interchangeable products.

### Cited Findings

| Candidate | Verified integration character | Recommendation and reason |
|---|---|---|
| OpenCode | `@opencode-ai/sdk` is a typed HTTP server client; server exposes OpenAPI and events, session cancellation and permissions. Server supports password authentication. MIT source license. [SDK](https://opencode.ai/docs/sdk/), [server](https://opencode.ai/docs/server/), [license](https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE). | Strong reference for separating headless sessions from UI. Do not replace the current Pi integration merely to gain a server: it creates another privileged service and migration. Reconsider for a deliberately remote/client-server product. |
| Claude Agent SDK | Python/TypeScript library drives Claude Code binary, with tools, sessions, subagents, hooks and MCP. Commercial terms apply. Third-party claude.ai login/rate-limit use requires prior approval. [Overview](https://code.claude.com/docs/en/agent-sdk/overview). | Optional later isolated coding specialist for authorized API accounts; not the provider-neutral core. Benefit is integrated coding workflow; tradeoff is vendor/runtime/terms coupling. |
| Codex SDK / app-server | SDK supports local thread start/resume in Node >=18. Official docs direct custom interactive clients to app-server for auth/history/approvals/streaming. App-server uses a version-specific bidirectional protocol with stdio available. [SDK](https://learn.chatgpt.com/docs/codex-sdk), [app-server](https://learn.chatgpt.com/docs/app-server). | App-server is the appropriate possible later specialist adapter; SDK suits automation. Use a supported integration with explicit auth, not terminal output scraping. Keep Pi as coordinator rather than nesting an uncontrolled second coordinator. |
| OpenHands Software Agent SDK | Python and REST APIs, local/cloud execution, agent server and coding tools including Bash/browser/MCP. SDK MIT license. [SDK docs](https://docs.openhands.dev/sdk), [license](https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/LICENSE). | Useful reference for isolated repository workers and remote execution. Adds Python/server packaging to a Windows Electron app; not selected for the local desktop core. Its marketing benchmark claims do not establish desktop performance. |
| LangGraph + Deep Agents | Deep Agents is a harness over LangChain/LangGraph with planning, filesystem backends, subagents, summarization and human interrupts; JavaScript version documented. Deep Agents MIT license. [Overview](https://docs.langchain.com/oss/javascript/deepagents/overview), [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [license](https://raw.githubusercontent.com/langchain-ai/deepagents/master/LICENSE). | Strong workflow/durable orchestration reference. Adding it beside Pi duplicates state/control abstractions; only reconsider if deterministic multi-step business workflows become the dominant product. |
| Aider | Scriptable CLI and Python Coder interface; Apache-2.0 license. [Scripting](https://aider.chat/docs/scripting.html), [license](https://raw.githubusercontent.com/Aider-AI/aider/main/LICENSE.txt). | Focused code-edit benchmark/reference, not the unified browser/computer runtime. No demonstrated benefit warrants adding another Python toolchain to this rebuild. |
| OpenAI Agents SDK | In-app TypeScript/Python agent loop, tools, handoffs, custom state/approvals and tracing/evaluation integrations; distinct from hosted Agents API. [Official SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [runtime comparison](https://developers.openai.com/api/docs/guides/agents). | Useful reference for tracing/handoffs and optional specialized workflows. Replacing Pi would require requalifying storage, compaction, providers and tools without an evidenced product gain. |

- Claude `canUseTool` is not an unconditional interception hook: modes/allow rules may approve before reaching it; official docs recommend `PreToolUse` to gate every call. [Permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions).
- OpenCode docs surfaced both v1 and v2 permission naming/configuration. Pin a version and its generated schema instead of mixing documentation examples. [V1 permissions](https://dev.opencode.ai/docs/permissions/); [V2 permissions](https://dev.opencode.ai/v2/docs/permissions/).
- Codex app-server documents unauthenticated non-loopback WebSocket exposure unless configured and labels WebSocket transport experimental/unsupported. Prefer a contained stdio child for a local integration. [App-server protocol](https://learn.chatgpt.com/docs/app-server).

### Inferences

- MCP belongs at the tool integration boundary; ACP at editor/agent interoperability; LSP at language tooling. None replaces the mission runtime, action journal or desktop permissions. Browser/OS driver selection belongs in the companion tools research.
- Avoid recursively combining Pi + OMP + OpenCode + Codex + Claude loops in one ordinary task. The host must own stop propagation, budgets, workspace ownership and approvals if optional specialists are eventually introduced.
- Every external harness adapter must pass the same broker, cancellation and recovery contract; “has permissions” in a feature list is insufficient.

### Gaps

- Alternative release artifacts, Windows installers and end-to-end licenses of all bundled dependencies were not qualified. They are comparison/reference candidates, not approved shipping dependencies.
- Codex and OpenAI Agents SDK exact component-license manifests were not established from fetched official docs; verify redistributed artifacts and dependencies before adopting. Avoid presenting a legal conclusion based on open-source branding alone.

## What must remain Midnight-owned, and what should be validated before rebuilding?

### Takeaway

Own the guarantees users rely on: authority, durable action identity, actual success, cancellation, private data handling and total cost. Evaluate candidate cores under identical host contracts before allowing a feature list to decide architecture.

### Cited Findings

- The existing utility-process entry routes desktop operations to the main shell and handles cancellation/settings/auth messages. This supplies a useful seam but does not demonstrate OS confinement. [Host process](C:/zsolusi/midnight.app/src/runtime/host-process.mjs).
- Pi can resolve a credential from an executable command prefixed with `!`; therefore accepting arbitrary auth configuration introduces command execution. [Providers](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md).
- Anthropic's fetched Agent SDK overview explicitly restricts offering third-party claude.ai login/rate limits absent approval; this applies to the proposed integration and must appear near account design, not be buried in a risk appendix. Use API authentication or a separately verified authorized arrangement. This is the documented Anthropic rule, not a claim about all providers. [Overview, accessed 2026-10-12](https://code.claude.com/docs/en/agent-sdk/overview).
- OpenAI's official Sign in with ChatGPT page currently lists supported partner tools including Pi and directs developers to registration/integration documentation. That does not establish Midnight's own eligibility merely because it presently shares Pi credentials. [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).

### Inferences

**Recommended ownership decisions and why**

1. Keep app-owned SQLite mission/action journal plus immutable artifact/receipt references. Pi JSONL preserves conversation, not business exactly-once semantics. Give actions stable identity across retries, approval-bound argument hashes, adapter version, preconditions, target, dispatch timestamp and states `prepared/authorized/dispatching/succeeded/failed/unknown/reconciled`. Unknown outcomes demand read-back/reconciliation; do not re-send merely because the model asks again.
2. Keep policy decisions below all engine tools. Explicitly register broker-backed tools only; deny unexpected tool names, runtime tool-set mutation and nested calls absent capability. Tool metadata is input to policy, not authoritative permission. Browser/OS/shell commands must face the same policy.
3. Put engine/provider credentials in the runtime host; keep ordinary worker environments scrubbed. Migrate legacy plaintext/shared credential paths only with backup, user-visible account mapping and rollback. Prefer OS-protected secret references; never share provider secrets with renderer, browser content, transcripts or subprocesses by default.
4. Use model capability metadata and smoke probes: image input, tool calls, structured outputs, context limit and cancellation behavior. Provider routing changes are explicit, and private/local mode must forbid silent cloud fallback. Unknown prices display as unknown, not zero.
5. Account for prompt, output, cache read/write, image and tool/provider costs plus every child/model retry. Enforce parent budget before admitting further calls and reserve in-flight allowance; concurrency can otherwise overshoot a budget. Record estimated versus billed cost and pricing-catalog date. Set role defaults through task evaluations, not a permanent claim that one model is always best.
6. Avoid cross-engine persistence migration by exporting Midnight's normalized mission/event/artifact schema, maintaining source-engine transcript references separately. Pin engine adapters and replay fixtures; upgrade in isolated releases with migration/rollback checks.
7. Keep normal users away from harness slash-command catalogues, prefixes, TUI hotkeys and package internals. The UI offers visible controls for submit, stop, resume, review and permissions while expert shortcuts remain optional. This honors both meanings of “reduce shortcuts”: fewer commands to memorize and no unverified engineering bypasses.

**Proposed qualification spike — targets, not existing measurements**

Candidates: A = current upstream Pi SDK 1.0.1 as control; B = coherently pinned upstream Pi 1.1.0; C = verified OMP v18.9.2 artifact in pinned Bun/standalone child. Never assume a repo tag equals an npm version; reconcile tag, tarball manifest, lockfile, hash, architecture and license first. Use a disposable Windows x64 profile/workspace with no real sign-ins, then an authorized API fixture. Suggested timebox: five engineering days for packaging and hard-contract evidence; stop a failing candidate rather than indefinitely patching it.

| Gate | Reproducible procedure | Proposed acceptance |
|---|---|---|
| Artifact integrity | Clean install from lock+artifact manifest; launch offline to ready; inspect loaded modules/processes. | Coherent versions/hashes, known licenses, zero undeclared downloads or ambient extension loads. |
| Host ownership | Register one safe broker tool and one denied effect; exercise direct, nested, deferred, MCP, programmatic/eval, subagent and background paths. | Zero effect without broker authorization; every admitted call yields correlated receipt; any bypass disqualifies. |
| Cancellation | Interrupt during stream, queued tool, approval, child tool, PTY read and desktop action; revoke device lease before awaiting model abort. | Zero new dispatch after revocation epoch; UI stop acknowledgement p95 <=150 ms; hung worker terminated within a declared <=2 s local deadline; already-dispatched effects marked unknown/reconciled rather than falsely undone. |
| Recovery | Fault-inject at ten boundaries from intent persistence through receipt commit, ten repetitions each; restart and ask model to retry. | Zero duplicate external effects, no invented success, every ambiguous action exposed for reconciliation. |
| Persistence/compaction | Long conversation with image/tool output, compaction, branch, process kill, resume and two simultaneous missions. | Durable action/approval/task constraints survive; contexts isolated; engine “settled” never automatically marks task successful. |
| Provider/auth | API/local endpoint, expired credential, 401/429, unavailable image model, offline transition, privacy mode. | Deterministic supported error/fallback behavior, no secret in artifacts/logs, no forbidden egress, no unauthorized subscription workaround. |
| Windows packaging | Non-ASCII/spaced paths, locked files, PowerShell, process trees, installed per-user build without dev toolchain. | All declared supported cases pass; PID/job ownership and cancellation verified; Node/Bun/native requirements fully bundled or explicitly prerequisite. |
| Streaming fidelity | Unicode, ANSI output, 2 MiB+ tool artifact, reconnect and slow consumer. | Lossless final text/receipt correlation, bounded memory, safe escaping; OMP v2 framing tested if used. |
| Cost/quality | At least 30 representative tasks across coding/browser/computer/research, three runs each, identical model/budget/tool fixtures; separately compare native OMP feature configuration. | Record success with evidence, unsafe acts, user intervention, wall time, all tokens/cost, startup/RSS. No benchmark victory from different models or unequal budgets. |

Selection rule: mandatory safety/recovery/packaging gates precede quality. Keep Pi 1.0.1 if 1.1.0 regresses; adopt qualified 1.1.0 only after conformance and rollback pass. Prefer Pi on a tie. Promote OMP only if it passes every hard gate, retains provider/privacy requirements and shows a meaningful paired improvement (predeclare e.g. >=10 percentage points verified success or >=20% lower total cost/latency without quality loss); report uncertainty and enlarge the task sample before claiming superiority. These thresholds are proposed product decision criteria, not industry standards. A small sample cannot support a sweeping “best in class” claim.

Reversal rule: if Pi cannot provide complete tool interception, reliable packaged operation or supported provider integration without a permanent invasive fork, choose the first fully passing challenger under the same host contract. Maintain only that selected production adapter; archive losing spike code/evidence. Revisit Durable only on a documented API/compatibility improvement, not each ordinary release.

### Gaps

- No new package build, auth flow, throughput measurement or paid eval was performed. The plan must schedule these before release and label all numeric targets proposed.
- Child-process/utility-process isolation is not confinement; the OS/browser/terminal specialist must define the actual sandbox and capability boundaries.

## Source ledger and research limits

### Takeaway

The following primary documents were accessed on **2026-10-12**. Release facts are anchored where available; current-main API descriptions require revalidation against the exact release artifact before implementation.

### Cited Findings

| ID | Title / publisher | Version or status | Relevant support |
|---|---|---|---|
| P1 | [Pi repository](https://github.com/earendil-works/pi), Earendil Works | Current canonical repository | Identity/namespace migration |
| P2 | [Pi v1.1.0 release](https://github.com/earendil-works/pi/releases/tag/v1.1.0), Earendil Works | Oct 7; abe508e | Candidate version |
| P3 | [Tagged Pi manifest](https://raw.githubusercontent.com/earendil-works/pi/v1.1.0/packages/coding-agent/package.json), Earendil Works | v1.1.0 | Node requirement, exports, license/dependencies |
| P4 | [Pi README](https://raw.githubusercontent.com/earendil-works/pi/main/README.md), Earendil Works | main snapshot | Scope, permissions, Windows, supply chain |
| P5 | [Pi SDK](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/sdk.md), Earendil Works | main snapshot | Sessions/events/MCP |
| P6 | [Pi factory source](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/core/sdk.ts), Earendil Works | main snapshot | Injection/configuration seams |
| P7 | [Pi extensions](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/extensions.md), Earendil Works | main snapshot | Nested execution interception |
| P8 | [Pi providers](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/providers.md), Earendil Works | main snapshot | Credential behavior |
| P9 | [Pi Durable](https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/README.md), Earendil Works | Experimental main | Stability limit |
| O1 | [OMP repository](https://github.com/can1357/oh-my-pi), Stencil Labs | Canonical upstream | Identity |
| O2 | [OMP release](https://github.com/can1357/oh-my-pi/releases/tag/v18.9.2), Stencil Labs | Oct 11; bd4dffd | Latest observed release/change scope |
| O3 | [OMP package](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/package.json), Stencil Labs | Retrieved 18.9.1 | Bun/MIT/exports |
| O4 | [OMP natives](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/natives/package.json), Stencil Labs | Retrieved 18.9.2 | Native dependency surface |
| O5 | [OMP SDK](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/sdk.md), Stencil Labs | main snapshot | Discovery, persistence, registry |
| O6 | [OMP source](https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/sdk.ts), Stencil Labs | main snapshot | Imports and explicit controls |
| O7 | [OMP RPC](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/rpc.md), Stencil Labs | main snapshot | Framing, lifecycle, host tools |
| O8 | [OMP extensions](https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/extensions.md), Stencil Labs | main snapshot | Interception |
| O9 | [OMP README](https://raw.githubusercontent.com/can1357/oh-my-pi/main/README.md), Stencil Labs | main snapshot | Author claims/features |
| A1 | [OpenCode SDK](https://opencode.ai/docs/sdk/), OpenCode | Unpinned docs | Client/server surface |
| A2 | [OpenCode server](https://opencode.ai/docs/server/), OpenCode | Unpinned docs | Auth/OpenAPI |
| A3 | [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), Anthropic | Unpinned docs | Binary integration, auth restriction, terms |
| A4 | [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions), Anthropic | Unpinned docs | Callback bypass semantics |
| A5 | [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), OpenAI | Unpinned docs | Automation and custom-client distinction |
| A6 | [Codex app-server](https://learn.chatgpt.com/docs/app-server), OpenAI | Unpinned docs | Interactive protocol and auth boundary |
| A7 | [OpenHands SDK](https://docs.openhands.dev/sdk), OpenHands | Unpinned docs | Python/REST execution |
| A8 | [Deep Agents JS](https://docs.langchain.com/oss/javascript/deepagents/overview), LangChain | Unpinned docs | Harness capability |
| A9 | [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), LangChain | Unpinned docs | Workflow-state reference |
| A10 | [Aider scripting](https://aider.chat/docs/scripting.html), Aider | Unpinned docs | CLI/Python surface |
| A11 | [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), OpenAI | Unpinned docs | In-app orchestration |
| A12 | [Agents comparison](https://developers.openai.com/api/docs/guides/agents), OpenAI | Unpinned docs | SDK vs managed API |
| A13 | [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sign-in-with-chatgpt), OpenAI | Unpinned docs | Partner integration route |
| L1 | [OpenCode MIT](https://raw.githubusercontent.com/anomalyco/opencode/dev/LICENSE), OpenCode | dev | License |
| L2 | [OpenHands SDK MIT](https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/LICENSE), OpenHands | main | License |
| L3 | [Deep Agents MIT](https://raw.githubusercontent.com/langchain-ai/deepagents/master/LICENSE), LangChain | master | License |
| L4 | [Aider Apache-2.0](https://raw.githubusercontent.com/Aider-AI/aider/main/LICENSE.txt), Aider | main | License |

### Inferences

- Keep source snapshots/checksums alongside final spike evidence because live branches and docs change. Treat license metadata as a starting inventory; redistributed bundles need a dependency-level license/SBOM review.
- The strongest evidence supporting the selected architecture is the combination of current upstream contracts and this app's existing recorded local gate, not comparative vendor marketing.

### Gaps

- Full Git commit hashes from GitHub API could not be retrieved through the web tool; release pages supplied abbreviated hashes and immutable tag URLs. OMP tagged raw manifest retrieval also failed; artifact resolution is explicitly a spike prerequisite.
- No claim is made that all possible harnesses were evaluated, that all upstream features work on Midnight's supported devices, or that the present code already satisfies the proposed release gates.
