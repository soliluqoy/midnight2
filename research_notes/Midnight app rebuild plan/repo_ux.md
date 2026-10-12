# Midnight repository audit and app-preserving UX rebuild

Research date: 2026-10-12. Scope: source inspection, existing visual baselines, narrowly scoped existing tests, primary accessibility/interaction references, and proposed design. No production files changed; no dependencies installed; no live accounts or desktop controls used. The user confirmed that reducing shortcuts means both fewer keyboard shortcuts and fewer engineering compromises. **Observed** means current repository; **historical** means a recorded earlier result, not revalidated now; **proposed** means a design decision or acceptance gate, not a shipped fact.

## 1. What is the app today, and what should survive the rebuild?

### Takeaway

This is already an Electron desktop mission agent with a substantial policy and recovery architecture, not an empty web chat or TUI. The useful rebuild is a staged replacement of incomplete capabilities and presentation behind existing contracts; it should preserve the capsule identity, mission history, approval integrity, and user credentials while making execution independently verifiable.

### Cited Findings

| Observation | Evidence and implication |
|---|---|
| Desktop platform is Electron 44.4.5; app 0.2.2; Node ESM and plain HTML/CSS/JS renderer; TypeBox 1.3.27. Electron Builder packages Windows x64, macOS arm64 and Linux x64. | [package.json](/C:/zsolusi/midnight.app/package.json:1). Do not replace the product with a terminal app just because Pi/OMP has a TUI. |
| Capsule is frameless, transparent, always on top, nonresizable, hidden from taskbar; renderer uses context isolation, sandbox, no Node integration and a preload bridge. Main controls sizing and placement. | [main.mjs](/C:/zsolusi/midnight.app/src/main.mjs:26), [window creation](/C:/zsolusi/midnight.app/src/main.mjs:196). Retain this shell and separation. |
| The capsule has idle, chat, mission, reading, settings and mission stack views. Mission stack groups Needs you, Active, Watching and History. | [index.html](/C:/zsolusi/midnight.app/src/ui/index.html:10), [app.js](/C:/zsolusi/midnight.app/src/ui/app.js:840). There is already task management beyond one chat. |
| Eight Pi-family packages are vendored at 1.0.1 with SHA-512 provenance marked upstream. | [manifest](/C:/zsolusi/midnight.app/vendor/PROVENANCE.json:2), [dependencies](/C:/zsolusi/midnight.app/package.json:24). README's description of midnight.server fork is stale relative to provenance. |
| Only adapter imports Pi APIs; host runs in a utility process, with fixed platform operations back to Electron. | [adapter](/C:/zsolusi/midnight.app/src/runtime/adapter.mjs:1), [host process](/C:/zsolusi/midnight.app/src/runtime/host-process.mjs:1), [architecture tests](/C:/zsolusi/midnight.app/test/architecture.test.mjs:24). This is the correct seam for a Pi-versus-OMP spike, rather than replacing UI/policy at the same time. |
| Pi owns conversation, retries and compaction. Midnight owns mission state, action journal, authority and outcome checks. Ambient extensions, skills, themes and context discovery are disabled. | [adapter](/C:/zsolusi/midnight.app/src/runtime/adapter.mjs:58). Explicitly reviewed project instructions will need a deliberate scoped path for coding; do not simply turn ambient discovery back on. |
| The earlier runtime spike chose coding-agent SDK over experimental Durable after finding duplicate-effect risks in both, unstable Durable API and missing demonstrated MCP compatibility. | **Historical** [ADR 0001](/C:/zsolusi/midnight.app/docs/adr/0001-runtime.md:12). Keep the app-owned journal regardless of harness. Some ADR file references are stale: broker gate is now in adapter.mjs; test/runtime-adapter.test.mjs is absent. |
| Tools presently assembled are mission planning, constrained files, sheets, calculation, chart/report authoring, demo mail/CRM and Electron web/browser/computer tools. | [tool registry](/C:/zsolusi/midnight.app/src/tools/index.mjs:17). **There is no terminal/PTY executor, code edit/patch service, repository worktree workflow or test/diagnostics service in the registry.** shell-tools.mjs means Electron-shell operations, not command-shell execution. |
| Pi defaults do not automatically provide missing coding tools here: the session receives explicit custom tools and their names. | [adapter](/C:/zsolusi/midnight.app/src/runtime/adapter.mjs:80). Adding a Pi dependency alone does not meet terminal/coding requirements. |
| Real connector support is a registry plus demo CRM/mail behind demoConnectors, default false. OCR, PDF extraction and PPTX output are recorded missing. | [tool registry](/C:/zsolusi/midnight.app/src/tools/index.mjs:24), [settings](/C:/zsolusi/midnight.app/src/settings.mjs:37), [known limits](/C:/zsolusi/midnight.app/docs/rework-status.md:55). Do not label fixtures production capabilities. |
| Browser windows are per mission, capped at 3, sharing persistent sign-in partition; crossing cap closes the least-recently-used window, including one whose task might still depend on it. | [browsers](/C:/zsolusi/midnight.app/src/desktop/browsers.mjs:9). Shared cookies are shared identity, not strong account isolation; queue/eviction policy needs mission-aware ownership. |
| Browser commit classification relies on button labels, submit attributes and Enter-in-form; failed probe returns empty object; type is classified as navigation. | [browser inspection](/C:/zsolusi/midnight.app/src/desktop/browsers.mjs:69), [shell tools](/C:/zsolusi/midnight.app/src/tools/shell-tools.mjs:68). This is heuristic defense, not proof that all external effects require authority. SPA handlers, autosave and labels in other languages need structured action scopes and adversarial tests. |
| Broker distinguishes acknowledged from verified, but a tool without verify defaults to verified using possibly empty verification references. | [broker](/C:/zsolusi/midnight.app/src/policy/broker.mjs:268). This undermines the UI's otherwise good verified-result language; missing verifier must not silently become independently verified. |
| Renderer reads engine projections and does not itself decide success; snapshot sequence handling, delayed bridges and existing UI regressions are tested. | [app.js](/C:/zsolusi/midnight.app/src/ui/app.js:1), [ui-check.mjs](/C:/zsolusi/midnight.app/scripts/ui-check.mjs:1), [ui-data tests](/C:/zsolusi/midnight.app/test/ui-data.test.mjs:1). Preserve these semantics while refactoring the renderer. |
| Current README also says multiple missions/charts/connectors are not built, despite stack/queue/chart generation/demo connectors existing. | [README](/C:/zsolusi/midnight.app/README.md:52), [current status](/C:/zsolusi/midnight.app/docs/rework-status.md:14). Documentation reconciliation is part of the rebuild; distinguish real connectors from fixtures. |
| Repo rules prohibit AI attribution and require rebuilding/vendoring after changes to sibling midnight.server. | [CLAUDE.md](/C:/zsolusi/midnight.app/CLAUDE.md:1). This research does not change the sibling repository, so no vendor/install action was needed. |

#### Actual default theme contract

The main palette is directly observed in [style.css](/C:/zsolusi/midnight.app/src/ui/style.css:1). Preserve these values as named primitives and derive semantic component tokens from them; do not introduce a unrelated black/white, blue SaaS or OMP-terminal visual skin.

| Primitive | Exact current value | Intended retained role |
|---|---|---|
| paper | `#0b0e1c` | Deep navy foundation |
| ink | `#f3eefe` | Primary text |
| muted | `#b0abca` | Supporting text |
| faint | `#8b86aa` | Tertiary text, with actual contrast checked per surface |
| line | `#2c2944` | Subtle separators |
| purple | `#8068e8` | Brand/action accent |
| lavender | `#bba9ff` | Focus, active work, highlights |
| pink | `#ff9fc7` | Sensitive action/screen-control badge |
| green | `#9be8c3` | Verified result |
| amber | `#ffc976` | Attention, unresolved/partial state |
| blue | `#91caff` | Links and watches |
| Capsule surface | `rgba(20,18,38,.97)` | Original translucent dark-purple body |
| Capsule border | `#4a4070` | Outline |
| Capsule shadow | `0 12px 32px rgba(3,3,12,.55), inset 0 1px 0 rgba(255,255,255,.07)` | Floating capsule depth |
| Idle dot | radial gradient `#fff1aa`, `#ffb884` at 60%, `#fa7caa` | Distinct warm living dot |

Other identity primitives: Segoe UI Variable Text/Segoe UI/system sans; Consolas/Cascadia Mono for small metadata/code; 26px radius idle capsule and 20px expanded capsule; 8–14px control/card radii. Idle is 264×52 CSS px; chat 440×150; mission/settings/stack 440×640; reading width 740 with dynamic screen-clamped height. Main's dimensions are authoritative; the CSS reading fallback 820 is not the runtime height. [CSS](/C:/zsolusi/midnight.app/src/ui/style.css:8), [main dimensions](/C:/zsolusi/midnight.app/src/main.mjs:26).

I visually inspected existing [chat](/C:/zsolusi/midnight.app/test/visual/baseline/chat.png), [approval](/C:/zsolusi/midnight.app/test/visual/baseline/mission-approval.png), and [reading](/C:/zsolusi/midnight.app/test/visual/baseline/read.png) PNGs. They confirm dark lavender surfaces, rounded border, warm attention dot, dense compact metadata, purple filled action buttons and mint completion checks. These are saved baselines, not fresh screenshots of a running app. All eleven saved states should become the initial identity regression set.

**Measured static contrast, not a full accessibility audit:** WCAG sRGB luminance calculation on exact CSS gives ink `#f3eefe` on purple `#8068e8` = **3.65:1**; white on purple = **4.15:1**. Current primary buttons inherit ink and use 12px text, so this pair misses the 4.5:1 normal-text target. Preserve the purple primitive but use dark paper #0b0e1c as its text semantic token (measured 4.63:1 on this fill), or a derived accessible fill; do not claim high-contrast preference repairs default buttons. Faint on opaque `#141226` is approximately 5.32:1, so faint text is not automatically a contrast failure. [button styles](/C:/zsolusi/midnight.app/src/ui/style.css:131), [WCAG](https://www.w3.org/TR/WCAG22/).

#### Keep, refactor, replace and build

| Action | Assets / subsystem | Why and constraint |
|---|---|---|
| Keep | Electron shell, capsule identity, tray, display-aware placement, isolated renderer/preload | These meet the actual desktop product; a simultaneous platform rewrite adds risk without proving better task completion. |
| Keep, harden | Domain contracts, journal, mission repository/projection, broker, approvals, grant scopes, screen leases, intent/reconciliation ledger | Harness choice does not solve durable effects, stop semantics or evidence. Do not weaken them to adopt an upstream convenience. |
| Keep, update | Runtime adapter boundary and single production runtime | Enables fair Pi/OMP experiment without UI/mission churn; no two-engine permanent maintenance burden. |
| Refactor | 1,000+ line app.js and settings.js into view/store/action/component modules with explicit state and typed events | Prevents task lifecycle, UI focus and pending async responses becoming entangled; preserve existing stale-response guards. Do not select a UI framework solely for fashion. |
| Refactor | Tool registry into explicit capability manifests | Advertise installed, authorized and verified capabilities accurately; no undefined tool promises. |
| Replace/harden | Browser label heuristics as sole effect detector; success-without-verifier fallback; global Escape ownership logic | These are correctness gaps that styling cannot fix. |
| Build | Terminal/PTY and process lifecycle, patch/diff/editor, git/worktrees, diagnostics/test integration | Required for the requested coding/terminal product; absent today. Reuse the broker for effect scopes and the artifact store for results. |
| Build | Real connector adapter(s), document extraction/rendering services, platform-specific desktop backends | Add in capability increments with independent fixtures; disclose unsupported platforms. |
| Keep, extend | Visual fixtures, architecture checks, faux-model E2E, hostile inputs and crash tests | Strong existing starting point; extend to actual desktop/browser/terminal execution. |
| Replace | Stale README/ADR file references and broad unqualified capability claims | Documentation must describe tested shipping behavior; preserve historical measurements with dates. |

### Inferences

- A full delete-and-rewrite would throw away useful journaling/recovery and state-race tests. Prefer a branch with vertical increments behind narrow interfaces, and prove each replacement on the same task fixtures before removing the old implementation.
- Restoring coding-agent default tools wholesale could bypass Midnight's effect policy unless every direct/nested/background operation is brokered; tool convenience must not decide trust.
- A signed-in browser partition shared by missions needs account/scope visibility in the UI and partition keys for account/workspace when true separation is needed.
- The current application architecture is well suited to separating fast UI acknowledgments from long model/tool work. The proposal below builds on that rather than exposing runtime details to users.

### Gaps

- No dependency installation exists in this checkout. Full app boot, current Electron regressions, real-model/task benchmarks and assistive-technology behavior were not run in this research.
- The earlier external PDF plan named in rework-status.md is not present in the enumerated repository files. Treat it as uninspected history, not a normative source for new claims.
- No end-user usability interviews or task-frequency analytics are present in inspected material. Proposed navigation and thresholds need validation, not assumptions about all users.

## 2. How should presentation and interaction improve while keeping the default theme?

### Takeaway

Keep Midnight as a quiet capsule that expands into a task workspace when the work needs room. Make the outcome and next action primary, keep control visible, and put detailed tool logs, provider metadata, runtime choices and shortcuts behind deliberate disclosure.

### Cited Findings

- Current prompt has no visible submit button: Enter sends, Shift+Enter adds a line; placeholder teaches `?`, `??`, and Up-arrow syntax. Chat baseline shows a crowded title row. [index.html](/C:/zsolusi/midnight.app/src/ui/index.html:16), [keyboard handlers](/C:/zsolusi/midnight.app/src/ui/app.js:944), [chat baseline](/C:/zsolusi/midnight.app/test/visual/baseline/chat.png).
- Current title row includes five icon buttons on mission view; read button single-click changes meaning once reading and double-click toggles reading again. [index.html](/C:/zsolusi/midnight.app/src/ui/index.html:36), [handlers](/C:/zsolusi/midnight.app/src/ui/app.js:1028). This is a discoverability issue, not a request for more shortcuts.
- Current mission body, answer, evidence, footer and checks can have independent overflow containers. Font sizes include 10–11.5px for many labels. Current icon buttons are 26×26px. [style.css](/C:/zsolusi/midnight.app/src/ui/style.css:45), [answer](/C:/zsolusi/midnight.app/src/ui/style.css:88), [checks](/C:/zsolusi/midnight.app/src/ui/style.css:299).
- Positive accessibility foundations already include inactive layers made inert/aria-hidden, descriptive labels, visible focus, reduced-motion support and throttled announcements. [app.js](/C:/zsolusi/midnight.app/src/ui/app.js:40), [announcements](/C:/zsolusi/midnight.app/src/ui/app.js:54), [CSS](/C:/zsolusi/midnight.app/src/ui/style.css:223), [reduced motion](/C:/zsolusi/midnight.app/src/ui/style.css:308).
- Auth overlay is marked dialog, but code does not show a focus trap, aria-modal, labelled heading or focus restoration; custom listbox and radiogroup have ARIA roles but no arrow-key handling or roving tab index. Approval focusFooter chooses askYes. These are code-review findings needing real AT validation. [settings dropdown](/C:/zsolusi/midnight.app/src/ui/settings.js:83), [segmented](/C:/zsolusi/midnight.app/src/ui/settings.js:116), [auth modal](/C:/zsolusi/midnight.app/src/ui/settings.js:569), [approval focus](/C:/zsolusi/midnight.app/src/ui/app.js:729).
- W3C recommends WCAG 2.2; relevant criteria cover text contrast, resize/reflow, keyboard operation, status messages and focus visibility. Use this as testable design criteria, not a declaration that an untested desktop app conforms. [WCAG 2.2](https://www.w3.org/TR/WCAG22/).
- WCAG 2.5.8's AA target-size rule is 24×24 CSS pixels or applicable spacing/other exceptions; 44px is the enhanced criterion, not the universal AA minimum. Existing 26px icons are not automatically failures. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Focus must not be completely hidden by authored content; scrollable/sticky cards must keep the focused element visible. [W3C focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).
- Character-only shortcuts need an off switch, modifier remapping or activation only when their relevant component has focus. [W3C character-key shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html).
- A modal should constrain Tab navigation, have proper naming/semantics, receive deliberate initial focus and restore focus on close; long structured content may initially focus a static heading. [W3C dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).
- Microsoft's HAX Toolkit offers 18 evidence-based guidelines organized across initial use, normal interaction, errors and longer-term use. The applicable product inference is to design failures/recovery and correction as deliberately as the first answer. [Microsoft HAX](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/).

### Inferences

#### Proposed principles and decisions, with reasons

| Decision | Why this is the right default | Tradeoff / rejection |
|---|---|---|
| Preserve palette, capsule silhouette, warm dot, typography family and soft depth | Maintains recognition and the requested default theme. | Geometry, contrast and spacing may improve; preserving a theme does not require preserving inaccessible text/focus behavior. |
| One task surface, with compact and expanded presentations of the same state | The user does not have to understand harness/session/browser-process architecture. | Expanded coding work needs more space, but remains optional; do not turn the default capsule into a full IDE. |
| Show task outcome, current action, blockers, controls and artifacts first | Users need to know what happened and what needs them. | Detailed traces are a disclosure, not a live wall of logs; experts retain access. |
| Every task can be run and controlled without memorized shortcuts | Directly satisfies reduced shortcut reliance. | A few configurable accelerators remain for convenience and emergency control. |
| Distinguish planning, running, verifying, partial, failed, cancelled and unknown outcome | A model stopping is not task success. | More explicit state labels are necessary, but only show the current meaningful state. |
| Keep sensitive approvals anchored to exact task/action content | User must recognize recipient/account/file/content before approving. | Context may require expanding the workspace; never compress essential consequences into a tooltip. |
| Use deterministic receipt/evidence records and verifiers for success presentation | Fixes mismatch between attractive completion UI and weak backend proof. | Additional verification latency is acceptable; communicate Checking rather than pretend completion. |
| Display concrete capability unavailable states with a useful fallback | Makes browser/desktop/platform limits understandable. | A partial result may be the honest answer; it must not count as task-completion success in capability evaluation. |
| Focus stays where user is working during streams and updates | Prevents interrupted typing, accidental action and lost reading position. | New information uses a badge/Jump to latest affordance rather than forcing scroll. |
| Native semantics before custom ARIA widgets | Standard selects/buttons/dialogs reduce keyboard and screen-reader work. | Custom styling stays within Midnight tokens; custom composite widgets need full APG behavior. |

#### App-preserving screen model and wireframes

These are proposed layouts, not screenshot claims. Use existing capsule dimensions first; allow a user-resizable expanded workspace with the same theme for terminals, diffs and browser/desktop evidence.

```text
RESTING CAPSULE (same 264 x 52 silhouette)
 [warm dot] midnight                      [needs you 1]
 Click anywhere / configurable summon / tray action

COMPOSER (compact, height can grow for accessibility)
 [dot] midnight                           [Tasks] [More]
 [ Ask or give a task...                                  ]
 [ + Files / folder ] [Auto v]                    [Run ->]
  Scope: Project A · Account: Work · Cloud model    (when relevant)

ACTIVE TASK
 [dot] Update checkout flow                  [Expand] [More]
 Running · Inspecting payment tests
 Plan 2 of 4     [View steps]
 [Latest meaningful activity; details expandable]
 [Result/artifact preview, as available]
 [Tell midnight something...                  ] [Send]
 [Pause] [Cancel task]       [Take over computer] (only leased)

EXPANDED TASK (same colors, radii and type families)
 Task title / lifecycle / scope               [Compact] [More]
 [Result] [Activity] [Files & changes]       [Browser/Computer*]
 Main pane: answer, artifact preview, diff, terminal or live view
 Details drawer: sources, commands, receipts, checks, cost
 Composer pinned at bottom; visible Pause / Cancel / Take over
 *Only show relevant tabs; do not start with empty capability tabs.

NEEDS APPROVAL
 Send report to Sam · from Work account
 To: sam@example...   Attachments: report.docx rev 4
 Content preview (expand to read completely)
 Consequence: sends 1 message; cannot be recalled here
 [Keep draft] [Edit]                         [Send message]
 [More options: create a scoped routine] (not equal primary weight)

FINISHED / PARTIAL RESULT
 Outcome: 2-line plain-language result and any remaining gap
 [Open report] [Open changed files] [Review diff] (as appropriate)
 Checks: 18 tests passed; 1 unrun integration test [Details]
 Sources / receipts / changed paths available inline
 [Follow-up...                                      ] [Send]
 [Copy] [New task]                  [More: Save routine, export]
```

#### Default controls versus advanced controls

Default: task entry with visible Run; Files/folder context; current scope/account/privacy where meaningful; Tasks; visible lifecycle status; Pause and Cancel while running; Take over computer only during computer control; reviewable action approval; result/artifact opening; follow-up; More; expanding/compacting the workspace. Model name can be tucked into More or a concise configurable chip, without provider jargon filling the title row.

Advanced: provider/model/thinking controls, token/cost breakdown, raw tool arguments, receipt hashes, trace export, browser session/partition configuration, custom shortcut remapping, MCP manifests, concurrency/resource budgets, reusable rules. Display these where they answer a user's question rather than as implementation vocabulary in every task.

Settings proposal: General (launch/position/readability), Models & accounts, Workspaces & permissions, Connections & capabilities, Routines & schedules, Data & privacy, Advanced/diagnostics. Preserve existing settings values and unknown keys through migration. Defaults continue to use the user's current theme; high contrast and reduced motion are accessibility options, not a rebrand.

#### Keyboard simplification and conflict repair

Current app-specific controls include summon Ctrl/Cmd+Alt+M; hide Ctrl/Cmd+H; read Ctrl/Cmd+E; copy answer Ctrl/Cmd+Shift+C; new task Ctrl/Cmd+L; text zoom +/-/0; source digits 1–9; prompt Up/Down history; `?`/`??` prefixes; Escape with multiple meanings. [keyboard source](/C:/zsolusi/midnight.app/src/ui/app.js:944), [main hotkeys](/C:/zsolusi/midnight.app/src/main.mjs:95).

Proposed policy:

1. Keep one configurable **global summon** accelerator; always expose tray/capsule equivalents. Handle registration failure visibly and keep existing shortcut when replacement fails.
2. Keep standard editing/navigation: Tab/Shift+Tab, Enter/Space on controls, copy/paste/select-all, normal zoom. Composer Enter-to-send remains configurable, visible Run works for all users, Shift+Enter inserts newline. Honor IME composition before treating Enter as submit.
3. Remove default global source digits, magic prefix teaching, read/copy/new bespoke accelerators and prompt-history arrow interception. Provide clickable source links, Auto/Quick/Research mode choices, visible New task and ordinary text navigation. Optional advanced remapping can restore old behavior for users who want it; migrate preference rather than silently breaking power-user settings.
4. **Escape hierarchy:** while computer lease active, emergency release of keyboard/mouse wins and produces an immediate visible acknowledgement. Outside that scope, Escape closes the topmost menu/dialog and returns focus, then may compact the capsule when appropriate. Never globally capture plain Escape for unrelated background research or terminal work.
5. Distinguish **Pause task** (stop scheduling; define what happens to active work), **Cancel task** (abort cancellable operations, reconcile uncertain effects), **Take over computer** (revoke screen input lease), and **Emergency stop all** (block new dispatch and stop workers with documented limitations). All have visible controls; emergency stop all is also in tray. Do not relabel these all Stop.
6. Terminal-focused keys belong to the terminal, including Ctrl+C interrupt; global app listeners must not steal terminal/editor chords. Provide the escape hatch outside the terminal and preserve assistive-technology/browser shortcuts.

Refined current Escape issue: main registers global Escape whenever any mission is active or a screen lease exists. Its takeover function revokes the screen lease and signals its owner; renderer then pauses that owner **or currently viewed RUNNING mission**, if any. Thus non-screen tasks can be paused if currently selected, but Escape does not reliably mean stop all running work, is captured when other apps have focus, and may pause no task when there is no relevant selection. README says abort while source says pause. [main](/C:/zsolusi/midnight.app/src/main.mjs:95), [renderer fallback](/C:/zsolusi/midnight.app/src/ui/app.js:323), [README](/C:/zsolusi/midnight.app/README.md:39).

#### Required presentation behavior by content type

| Surface | Proposed behavior | Why / proof users need |
|---|---|---|
| Streamed answer | Render semantic Markdown incrementally; preserve text selection and focus; follow only when at bottom; Jump to latest otherwise; show provisional answer until checks finish | Current renderer already detects whether user is near bottom; retain it. Avoid rebuilding the entire answer subtree on each text burst as content grows. |
| Tool activity | Compact human label, target, state, elapsed time; expandable exact request, output and exit/result; group repeated observations without hiding failed actions | Legible activity matters more than raw JSON; logs remain inspectable. |
| Plan | Short current step plus expandable steps, intended outputs and approval boundaries; user can adjust intent before execution | Prevent forced large plans for simple questions, while action scope stays clear. |
| Approval | Exact account/destination/path/value/attachment version/content preview; specific action verb; defer/reject/edit; unknown effects explained | Approval nonce/hash/backend gating already exist; do not lose them in presentation refactor. Default focus goes to heading or safe action, not Send/Approve. |
| Terminal | Exact shell/cwd/command, running vs background vs waiting-input, streaming output, exit code and duration, scoped cancellation; plain-text accessible transcript; escape-sequence handling | A screenshot of a terminal is not a reliable or accessible execution record. No interactive input without explicit transfer to user. |
| Code diff | File tree summary with add/change/delete; unified default, side-by-side when space allows; line context; binary/rename/deletion states; conflict and test status | User can review actual edits before external publication. Approval should bind the reviewed revision. |
| Files/artifacts | Filename/type/path/revision, preview, open/show-in-folder/download/export, verified/unverified indicator; honest unsupported-format state | Do not require reading hashes for ordinary use; hashes/receipts live in details. |
| Browser | Task-owned browser identity/account/domain, current page and human-readable action, Show browser, pause/control handoff, login/MFA/CAPTCHA state | A hidden window must not imply invisible identity or unreviewable external actions. |
| Computer | Prominent current app/window/monitor, screen-owner task and Take over; overlay cannot cover target; stale/out-of-scope target blocks input | Maintain existing purple cursor/frame identity; text status and controls provide non-color alternatives. |
| Evidence | Link each substantive claim/check to source/version/time/locator, show read versus inferred versus tool-acknowledged versus verified; sources navigate safely | Source existence alone does not prove a result. Unknown effects stay amber, not mint. |
| Recovery | What was completed, what is uncertain, what will resume, safe retry vs reconciliation; specific user action if needed | Prevent replaying a send because runtime restarted. |
| Failure/empty/loading | User-facing cause, preserved drafts/artifacts, next action; distinguish no connection, no permission, unsupported platform, rate/budget limit and internal failure | Avoid generic red error toast as the entire recovery experience. |

#### Core user journeys to prototype and validate

1. First run: explain where task data goes in ordinary language; connect a provider/local endpoint; choose a folder only when task requires one; run a harmless first question; show where tasks/history live. Do not force all permissions or every setting at startup.
2. Research: ask normally, choose Research only when wanted, see sources and a short result, expand into reading view, follow up without replaying previous answer as new output.
3. Coding: choose repository, identify dirty state, state requested outcome, create isolated task workspace when needed, watch tests, review diff and evidence, open files locally; commit/push/PR are explicit external or repository mutations with scoped authorization.
4. Browser workflow: choose relevant account/session, preview planned destination/action, handle sign-in by user, run in visible-on-demand browser, verify server state, show receipt. Unexpected account/domain changes invalidate relevant permission.
5. Computer work: show exact app/window and control ownership; user can take over instantly; pause/resume reacquires fresh target and observations; no blind continuation after focus/display change.
6. Long task: submit and return to own work; capsule badge changes only for meaningful needs; clarify in task; cancel or pause safely; restart app and recover with same task history/receipts.
7. Scheduled routine: create from successful task, review scope/budget/frequency/quiet hours, inspect next run, pause/revoke, see missed-run policy and last result; never treat suggested memory as granted authority.

### Gaps

- No interaction design was tested with real users in this research. Wireframes and navigation decisions require task-based usability sessions.
- No live NVDA/Narrator/VoiceOver, high-DPI/multimonitor or keyboard layout pass was performed. Existing ARIA markup alone is not proof of accessibility.
- Resting dot CPU measurements are historical; changing motion or window topology requires rerunning profiling, not assuming animation is free.

## 3. What implementation sequence and evidence gates make the rebuild reviewable?

### Takeaway

Preserve the current app as a baseline, resolve lifecycle and evidence correctness first, then add complete capability slices with matching presentation and tests. Measure real task outcomes separately from safe refusal/honest partial outcomes so a harmless but incapable agent cannot pass as best in class.

### Cited Findings

#### Checks actually run during this research

- Environment reads: `node --version` = **v24.21.0**; `npm --version` = **11.19.0**; `Test-Path node_modules` = **False**. No install attempted, because the task is a research/plan deliverable.
- First targeted invocation: `node --test --test-timeout=60000 test/markdown.test.mjs test/harness-utils.test.mjs test/models.test.mjs test/web-headless.test.mjs` produced **8 passing tests and 1 file-load failure**. `web-headless.test.mjs` could not import **typebox** through schemas.mjs; this is missing dependencies, not an observed behavioral test regression.
- Dependency-free rerun: `node --test --test-timeout=60000 test/markdown.test.mjs test/harness-utils.test.mjs test/models.test.mjs` produced **8/8 pass, 0 failed, 167.6ms**. Coverage: screenshot pruning, model fallback/routing, search URL dedupe, Markdown links/citations/sanitization. Screenshot pruning fixture reduced serialized payload **961,407 to 241,416 chars (74.9%)**; this is a fixture benchmark, not whole-app speed or cost improvement.
- Test definitions: [harness utility tests](/C:/zsolusi/midnight.app/test/harness-utils.test.mjs:8), [Markdown tests](/C:/zsolusi/midnight.app/test/markdown.test.mjs:10), [model tests](/C:/zsolusi/midnight.app/test/models.test.mjs:16). Raw outcomes are tool outputs in this research session, not a stored full app test report.

#### Historical checks, explicitly not rerun

- Status document dated 2026-10-04 records 52/52 npm tests, real Electron smoke without renderer errors, 11 visual states and partial real-model research evaluation r01–r08 with 23/23 expected outcomes and 0 critical violations. [status](/C:/zsolusi/midnight.app/docs/rework-status.md:10), [partial eval](/C:/zsolusi/midnight.app/docs/rework-status.md:36).
- Faux E2E uses real Pi sessions with scripted faux provider and fake shell. It is valuable deterministic integration coverage, not evidence of real computer/browser reliability. [E2E helpers](/C:/zsolusi/midnight.app/test/e2e-helpers.mjs:1).
- Eval runner exposes real public-web search/read but explicitly no browser/desktop execution; many honesty/desktop scenarios allow partial/failed outcomes. Aggregation uses expected status plus required checks. [runner](/C:/zsolusi/midnight.app/evals/run.mjs:81), [scoring](/C:/zsolusi/midnight.app/evals/run.mjs:131), [desktop cases](/C:/zsolusi/midnight.app/evals/scenarios.mjs:72). This cannot demonstrate best-in-class browser/desktop execution.
- Idle profiling recorded 243MB median private memory, 0.03% median one-core CPU with resting dot; startup p95 around 318MB, missing model/browser/desktop/24h soak/battery/100-mission leak data. [performance](/C:/zsolusi/midnight.app/docs/performance.md:7). Preserve baseline workload, hardware and time units when comparing.
- Visual CI currently only ensures rendering without errors; pixel baselines machine-specific. Unsigned distribution builds do not receive automatic signed-update installation. [limits](/C:/zsolusi/midnight.app/docs/rework-status.md:59).

### Inferences

#### Proposed stepwise delivery plan

| Step | Concrete work and decisions | Exit evidence |
|---|---|---|
| 1. Freeze evidence and inventory | Record current commit, dependency/provenance, installed-profile schema and settings; map each user capability to implementation/platform/account requirements; preserve 11 visual baselines and default token set. Reconcile README/ADR references. | Reproducible inventory and explicit unavailable capabilities, no product code rewrite yet. |
| 2. Define lifecycle and capability contracts | Agree runtime/tool/action/receipt/evidence/cancellation schemas; separate acknowledged from verified and partial from succeeded; model errors, capabilities absent and uncertain effects explicitly. | Contract tests demonstrate every UI state derives from engine facts, not prose. |
| 3. Repair trust and stop semantics | Remove default verified fallback; make effectful tools implement verifier/reconciler or remain acknowledged/unknown; precise permission scopes; ensure pending approvals survive and hash changes invalidate; fix Escape/Take over/Pause/Cancel/Emergency semantics. | Adversarial, stale-approval, double-send and process-kill tests; no new input after acknowledged lease revoke. |
| 4. Prototype the same-theme task surface | Implement semantic tokens, compact/expanded layout, visible Run and task controls, readable result/preview, progressive details, correct modal/listbox behavior, shortcut opt-in. Use fixture engine events. | Golden states plus keyboard/AT proof; contrast fixed without changing brand palette. |
| 5. Complete terminal/coding vertical slice | Repository context + dirty-tree handling; isolated worktree when needed; brokered exec/PTY; patch with conflict detection; tests/diagnostics; diff/file artifact viewer; resumable background process lifecycle and cancellation. | Real command and repository fixtures, native Windows path/encoding/PowerShell cases, process-tree cleanup; final result references changed files and actual tests. |
| 6. Complete browser slice | Per-task page ownership, per-account/profile scope, semantic actions with stable targets, explicit navigation/download/upload/popup handling, login handoff, freshness checks and postconditions. | Actual browser fixtures covering async SPAs, autosave, cross-origin, redirects, downloads, stale targets, network failure and restart; no label heuristic as sole permission guarantee. |
| 7. Complete desktop slice | Platform backend interface, semantic accessibility tree first where available, screenshot fallback, coordinate transforms/DPI/multimonitor, window identity, focus/lease checks, control overlay/handoff and postconditions. | Real desktop fixture suite on each supported OS; platform support badge reflects results, not packaging availability. |
| 8. Fill document/connector gaps | Real chosen connectors with OAuth/scopes; document extraction/OCR and file rendering; preview before external effect; data/version lineage and independently checked output. | End-to-end create/read/edit/render/export tests; demo fixtures never appear as connected accounts. |
| 9. Integrate long-running work | Queue fairness, concurrency caps, memory/routine review, budgets/quiet hours, crash recovery, resource-aware browser/worker eviction, user handoff and no duplicate effects. | Restart/soak/100-mission runs; paused task truly pauses new dispatch; background tasks do not steal focus. |
| 10. Performance and accessibility | Profile the actual slices; virtualize long logs, bound retained output, offload parsing, reduce hidden work; 200% zoom, reflow and screen-reader audit; test non-US layouts/IME. | Published distributions for UI latency, stop latency, resource use and task outcomes; no aggregate score masking unsupported platform/task categories. |
| 11. Migration and release | Schema backup/rollback, preserve auth locations and existing user data, signed builds, staged updates, runbooks, support bundle redaction, installed-build smoke and uninstall/data choice. | Upgrade from current 0.2.2 fixture profile succeeds; rollback rehearsed; signed artifact/update chain validated; no credentials logged. |
| 12. Independent review and iterate | Re-run same predeclared suite, investigate every severe failure, test held-out tasks and real users; compare candidates at matched model/cost/tool budget. | Decision record documents observed evidence, unresolved limitations, tradeoffs and why chosen alternative won. |

The engine-choice agent will supply Pi/OMP/framework evaluation. These steps deliberately make the runtime substitutable while preserving Midnight-owned invariants. Implement UI and capability slices in parallel only after contracts are stable; no speculative giant migration before a passing vertical slice.

#### Proposed acceptance targets (not measured results or guarantees)

| Area | Initial gate | Method / scope |
|---|---|---|
| Theme identity | 100% original palette primitives preserved; every changed component uses semantic tokens | Token snapshot + eleven baseline states reviewed; accessible derived tokens documented. |
| Ordinary usability | At least 90% completion of first-run, submit, find result, review approval, pause/cancel and recovery tasks without shortcut coaching; zero critical accidental sends in usability sample | 8–12 participants across experience levels initially; report sample size and qualitative failures, not population certainty. |
| Input reachability | 100% core journeys operable by keyboard and pointer; zero keyboard traps or hidden focused controls | Manual keyboard/AT plus automated checks; actual NVDA/Narrator and macOS VoiceOver where supported. |
| Readability | WCAG AA text contrast 4.5:1 normal/3:1 large; non-text essential contrast 3:1; 200% text/zoom without lost action controls | Measure actual composited surfaces and states; 24px minimum target criterion or applicable exception, project preference 36px general controls/44px primary actions where feasible. |
| State preservation | No lost composer text/selection/focus or stale task result under delayed/out-of-order updates | Fault-injected UI integration tests; 10,000 activity entries and repeated streaming updates. |
| UI responsiveness | Acknowledge submit/pause/local action within 100ms p95; show shell on summon within 150ms p95 warm; streaming display within 100ms p95 after receiving batch | Measure renderer/main timing separately from model/network latency on declared reference hardware. |
| Computer takeover | Acknowledge user takeover within 100ms p95; dispatch zero further desktop inputs after confirmed revocation; helper/process containment verified under load | Timestamped shell/helper test; stop-tail distribution and max are reported, not just median. Do not promise every already-dispatched OS event can be reversed. |
| Truthfulness | 100% succeeded task checks cite explicit verifier evidence; 0 success badges based only on tool return/no verifier | Contract and adversarial tests, manual sample audit. |
| Capability success | At least 90% actual task success per initial supported capability suite, 3+ repeats; 0 critical policy violations | Report actual completion separately from partial/refusal; sample size, confidence intervals, model, latency and cost disclosed; no best-in-class claim until a fair comparator beats current baseline. |
| Resource regression | No regression versus recorded idle target; aim <=250MB settled idle median and <=0.5% machine CPU median, with p95 reported; <=10% retained-memory growth after 100 equivalent missions after settling | Same machine/profile/workload as baseline; adjust targets explicitly if adding workers has justified cost. |
| Recovery | Zero duplicate external effects in induced crash/retry corpus; unknown outcome remains visible until reconciled | Test kill points before/after dispatch and acknowledgement with service-side idempotency/receipt validation. |
| Release gate | Full applicable tests pass; no unresolved critical/high severity trust, data loss, stop, migration or accessibility blocker | Matrix per OS/capability; unsupported cases are disabled or clearly labeled rather than waived silently. |

#### No engineering shortcuts: explicit non-negotiable practices

- Do not equate model completion, zero exit code, connector acknowledgement or screenshot acquisition with the requested business/task outcome. Define independent postconditions appropriate to each capability.
- Do not substitute documentation promises, mocked desktop execution or a research-only eval score for actual browser/desktop/terminal completion.
- Do not use a permissive unsandboxed shell as a universal escape hatch. Broker workspace, network, credential and external-effect authority across every execution path, including extensions and subprocesses.
- Do not silently install a second harness/runtime, fork upstream internals, mix package sources or copy OMP's TUI wholesale without a demonstrated need and maintained boundary.
- Do not solve keyboard clutter by making actions inaccessible. Visible controls, discoverability, standard keys and opt-in accelerators must coexist.
- Do not add raw account/session/runtime identifiers to ordinary user flows simply because engineering needs them in diagnostics.
- Do not let visual regression updates automatically bless a layout. Human review checks hierarchy, attention, meaning, focus and task completion in addition to pixels.
- Do not ship unavailable capabilities behind optimistic labels. Capability manifests and UI labels must reflect actual installation, platform, authorization, connection and tested support.

### Gaps

- Numerical targets above are proposals. They require a reference machine, workload definitions, baseline runs and agreement on release scope; these notes do not claim they have been achieved.
- Production model subscriptions/OAuth compatibility, licensing, signed release operations and broader harness comparisons belong to other research tracks. This audit confirms only what the current app does with its pinned packages.
- Final release scope and first real connector cannot be selected from source code alone; the plan can default to highest-value user workflows but must record these as product choices with validation gates.

#### Source ledger for report writer

Primary repo anchors: package.json; vendor/PROVENANCE.json; CLAUDE.md; docs/adr/0001-runtime.md; docs/adr/0002-dependencies.md; docs/rework-status.md; docs/performance.md; src/main.mjs; src/preload.cjs; src/contracts/ipc.mjs; src/runtime/adapter.mjs; src/runtime/host-process.mjs; src/tools/index.mjs; src/tools/shell-tools.mjs; src/desktop/browsers.mjs; src/policy/broker.mjs; src/settings.mjs; src/ui/index.html; src/ui/app.js; src/ui/settings.js; src/ui/style.css; scripts/ui-check.mjs; scripts/visual.mjs; test/architecture.test.mjs; test/e2e-helpers.mjs; test/visual/baseline/*; evals/run.mjs; evals/scenarios.mjs. Links above anchor relevant lines and distinguish current code from historical docs.

External primary sources retrieved 2026-10-12: [WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/), [target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html), [character key shortcuts](https://www.w3.org/WAI/WCAG22/Understanding/character-key-shortcuts.html), [modal dialog APG](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/), [Microsoft HAX guidelines](https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/). These provide principles; the detailed Midnight layouts, targets and implementation choices are the proposed synthesis above.
