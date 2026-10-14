# Midnight phase handoff

> **Historical phase snapshot, superseded by the v0.6.0 checkout.** The implementation was subsequently committed in `8d7b2e8`; `b05d911` records the v0.6.0 version/release notes. Settings now includes **General → Help with the selection**. See the [current implementation status](../docs/realtime-implementation.md) and [v0.6.0 release notes](../docs/releases/v0.6.0.md). The build hashes, test results, process observations and remaining qualifications below describe the original phase, not the current installation or published artifacts.

14 October 2026, Asia/Kuala_Lumpur. This phase ends at a verified development build containing narrow paragraph/chart assistance, local push-to-talk, two customizable plugin components, and a development source-proposal pipeline. The complete background assistant and installed self-repair experience remain unfinished.

At phase closure, the directory build under review was `release/goal-packaging-v0.5.0/win-unpacked/midnight.exe`; it had not been installed. The Midnight then running from `AppData/Local/Programs/midnight` was a separate installation without those changes. This historical artifact is not the current v0.6.0 build, and the phase checks do not establish the state of any later installed app.

## Decisions retained

| Decision | Agreed approach |
|---|---|
| Writing, reasoning and building | Use the configured cloud model. The real-account fixtures used `openai-codex/gpt-6.1-sol`; this is recorded test selection, not a requirement to use that model forever. |
| Local retrieval | Reuse the existing Gemma embedding model, projector and native runtime. Keep working ONNX profiles supported. |
| Speech for the first rollout | Local Whisper. Begin with a hotkey and push-to-talk. |
| Native cloud hearing and seeing | Add and qualify later. The adapter preview stays disabled by default. |
| Ambient assistance | Available eventually through explicit opt-in, after activation/privacy/resource qualification. |
| Local generative models | Optional. Gemma 4 is not a primary startup or download dependency. |
| Personal and official improvements | Support both from the beginning. Personal changes use private overlays; official changes produce reviewable candidates. |
| Plugin boundary | Keep startup, permissions, secrets, receipts, activation and recovery under a dependable kernel. Expand feature plugins as useful changes demonstrate the need. |
| Live app edits | Capture the selected object or paragraph, propose a narrow change, review, apply to the same target, and offer conditional undo. |

The full approved scope remains in [the realtime assistance plan](Midnight%20realtime%20assistance%20plan.md) and [the self improvement architecture](Midnight%20self%20improvement%20architecture.md). [The implementation tracker](../docs/realtime-implementation.md) contains the detailed requirement matrix and historical verification scopes.

## What this phase delivers

| Capability | Current implementation | Practical limit |
|---|---|---|
| Typed paragraph help | `Ctrl+Alt+Space` captures the selection before opening a dedicated prompt. A bounded cloud request produces a passive notice and an explicit before/after review. | Physical foreground use still needs qualification. Unsupported structures cannot be directly rewritten. |
| Formatted paragraphs | Rewrite plain text around protected styled phrases; retain tested font/highlight and paragraph properties. | Fields, hyperlinks, tables, tracked revisions, content controls and embedded objects remain outside direct rewrite qualification. |
| Native chart conversion | Change a selected native single-series 2D bar/column chart to pie, with review and reversal. | Qualified on WPS API 12.0/build 12.1.0.28485. Linked workbooks, other builds and Microsoft Word remain unqualified. |
| Review and undo | Separate proposal generation from native writes; persist the exact intent/connector identity; reconcile uncertain outcomes; reverse only against the expected post-edit state. | A missing old native handle remains unknown. There is no automatic retargeting by document filename or matching text. |
| Push-to-talk | Opt-in `Ctrl+Alt+Shift+Space`, original window identity, hidden 16 kHz recorder, up to 30 seconds, local final Whisper transcription, then the same review/apply flow. | Tested with synthetic audio. Personal microphone, physical held keys, foreground typing and multilingual quality remain unqualified. |
| Background scheduling | Bounded queues, lock/suspend/stop gates, shared model admission, idle unloading and builder cancellation ownership. | Full process-tree accounting, ordinary mission preemption, real battery behavior and long-running efficiency remain unfinished. |
| Existing Gemma embeddings | Cached native GGUF route with byte verification, model/projector pairing and backend fingerprints. | Backend changes require reindexing. Installed cache upgrades need qualification. |
| Personal customization | Charts and accent colors can be generated, previewed, checked and activated as private versions with rollback. | These are two registered components. Arbitrary connectors, workflows, dependencies and migrations are not yet supported. |
| Official proposals | The same chart/color components can produce official source candidates without activating private output or publishing. | Review/release remains separate. |
| App source changes | A separate builder can inspect a public checkout, make bounded source edits, validate frozen bytes and export an official patch/candidate. | Development checkout only. Windows candidate builds, app previews and installed source/toolchain delivery remain pending. |
| Independent recovery | A native executable outside ASAR can archive damaged component caches while retaining private source and core receipts. | Positive signed-installer recovery, official code corruption repair and physical recovery UI qualification remain pending. |
| Native media adapters | Separate bounded raw-media contracts, account/fixture qualification records and Gemini/OpenAI transports. | Protocol/loopback evidence only. No real media account qualification or live video/ambient experience is claimed. |

### The paragraph and chart path

Midnight captures a small local target record with its original app/window/document/range identity and expiry. Native identities stay out of model requests. Paragraph writing receives the selected text, protected phrases and instruction, without the rest of the document, conversation history, retrieval, attachments, standing instructions or tools. Quick generation is capped at 2,048 output tokens.

The model proposes text; it cannot write the document. Apply rechecks the original target and the exact reviewed proposal before dispatch. Number, citation and protected-formatting checks catch several obvious alterations, but they do not establish complete factual equivalence. The user still reviews the wording.

Chart conversion follows a typed local command and needs no generation call. The same native chart remains editable. Qualification checks its data, categories, source formulas, title, geometry and anchor. Changing back restores the tested type/data/properties; every bar-axis style is not guaranteed to survive a round trip.

Receipts are recorded before effects. A lost reply or post-effect storage error leads to inspection instead of replay. An unresolved native outcome blocks another native write in that app until it is reconciled. Undo requires the expected current poststate, so it does not blindly erase later user work.

### Hearing and background behavior

The first hearing route is Whisper transcription rather than native semantic audio reasoning. There is no always-listening mode in this phase. Model preparation starts for an explicit valid held gesture and can overlap recording; final transcription waits for release. Raw audio remains local on this route and is not stored as a mission attachment. The transcript and selected text follow the configured text-model privacy setting.

The current helper records at most 30 seconds. Release before recorder readiness discards a late stream. Lock, suspend, emergency stop, dismissal and language/privacy changes invalidate the gesture and late results. Speech is retained for up to 120 seconds on ordinary AC profiles and 30 seconds on battery/Quiet; embedding residency has a 60-second idle limit. These limits help constrain background cost but do not prove acceptable all-day CPU, memory or battery use.

Mission admission is bounded at eight quick requests, sixteen ordinary user tasks and four background tasks. Builder intents have a separate backlog of eight. Balanced/Burst reserve existing cloud capacity for quick assistance; Quiet/Focused/battery use shared capacity. A builder retains its slot until its owned process/worker/container actually exits or its absence is proven. Partial candidates remain available for explicit resume.

### Improvements and repair

The implemented feature contributions are `midnight.chart` at `chart.render/bar` and `midnight.theme` at `ui.theme/colors`. The host supplies their schemas, validator and activation binding. The separate builder produces candidates; the kernel activates an exact reviewed private version. Official proposals begin from the official base and exclude private overlays.

Generated charts run in a separate Chromium sandbox. Accent colors are a validated constant six-token map; the trusted UI paints the approved tokens without executing generated theme code. Private activations retain immutable artifacts, rollback information, generation checks and quarantine behavior. Another user's profile remains separate.

App-source work has its own official lane. Public `src`, scripts, tests, vendor inputs and package metadata form a bounded immutable base, candidate and frozen validation snapshot. The model can edit bounded source text under `src`; package/dependency/test/build inputs and binaries remain host-owned. A literal patch binds to the file digest and requires one exact occurrence. Core authority changes and native source changes receive review flags.

Source capture, hashing, editing, diffs, validation freeze and export run in a bounded trusted worker rather than blocking the host event loop. That worker never imports candidate modules. Requests persist before heavy source copying. The complete job shares resource admission through worker cleanup.

Unit validation runs in a pinned local Node/Git container with no network, read-only source/proof/dependencies, a non-root user, two CPU cores, 2 GiB memory and 128-process limit. Durable ownership records bind cleanup to the exact local Docker endpoint, daemon and container identity. A missing control plane retains ownership rather than falsely freeing the slot. This is operational confinement evidence; it does not certify resistance to every hostile-code or kernel escape.

## Verification and its scope

Existing reports retain their own timestamps and frozen source/build identities. A passing earlier report does not automatically qualify later bytes or broader user behavior.

| Evidence | Recorded result | What it establishes |
|---|---|---|
| Latest full native Windows unit run | 325/325 passed | Unit conformance before the final source promotion path guard. A subsequent targeted run passed 28 worker/host/queue checks after that guard. |
| Latest renderer suite | 59/59 passed | Actual renderer interaction checks using an isolated fixture bridge. |
| [Native paragraph/chart qualification](checks/word-native-chart.json) | 20 checks passed | Owned hidden WPS documents, narrow native writes, data/format checks, conflict refusal and reversal on the recorded WPS build. |
| [Whisper to cloud to native paragraph](checks/word-voice-cloud.json) | 12 checks passed; one cloud call | Synthetic English PCM, actual Whisper, configured cloud writer, one formatted WPS range, durable host/store restart and conditional undo. |
| [Packaged plugin builder](checks/builder-cloud-packaged.json) | 35 checks passed across four jobs | Actual separate builder/sandbox for personal and official charts/colors on that report's earlier packaged snapshot. |
| [Threaded real source proposal](checks/core-builder-cloud-threaded.json) | Five model calls; 528 seconds; 316 passed and nine Windows skips | One source wording change, exact patch/proposal and actual Linux container validation. No Windows candidate build or installed repair. |
| [Current source baseline validation](checks/source-validation.json) | 420 public files, 15,301,663 bytes; 316 passed and nine skips | Isolated Linux unit validation of that frozen baseline, before the final path guard and later fixture diagnostics. |
| [Packaged-module source worker](checks/source-worker-packaged.json) | Six checks; intent returned in 13 ms; maximum host heartbeat gap 78 ms | Actual Electron utility/ASAR modules with source I/O on a worker. Model and validator are scripted. |
| [Container ownership and isolation](checks/core-source-sandbox.json) | Ten checks passed | Actual resource/read-only/network controls and deadline/cancel/restart cleanup on the local Docker engine. |
| [Independent packaged recovery](checks/independent-recovery-packaged.json) | 18 checks passed | Damaged component cache, live ownership refusal, preserved receipt/profile fixture bytes and recovered startup on an earlier packaged snapshot. |
| [Latest directory package](checks/package-runtime.json) | 40 package checks; 21 smoke checks; engine ready in 1,831 ms; zero renderer errors | All 198 packaged runtime sources/assets matched at verification, helper/fuse checks, isolated startup and disabled microphone. The report contains 22 smoke lines, including the startup summary. |
| [Earlier installer compilation](checks/installer-build.json) | Unsigned NSIS artifact built, 164,348,000 bytes | Compilation only. It is an older snapshot and has not been installed or published. |

The combined voice fixture recorded 6.275 seconds from release to preview, 607 ms for apply and 571 ms for undo. These are one synthetic fixture's timings, not physical microphone or statistical foreground latency. The four packaged plugin jobs took approximately 46–84 seconds each; they are building tasks rather than quick-edit timings.

Source disk work remains expensive. The latest packaged-module fixture recorded approximately 15 seconds for capture, nine seconds for diff and 20 seconds for proposal export. Moving those operations off the host thread improves responsiveness; it does not eliminate disk contention. Small job-record persistence still runs on the host thread.

At phase closure, the directory executable and ASAR SHA-256 values still match the latest package report. That report contains the authoritative stored hashes; the closure check compared both files directly with it. No runtime source edit was made during this wrap-up.

## How to review the recorded phase build

The following instructions reproduce the historical v0.5.0 directory artifact only, if it is still available. For current development use the [README](../README.md) and verify a freshly built package; do not substitute the historical package report for checks of new bytes. Do not use the older NSIS installer as a final delivery. The portable directory needs its adjacent resources and helpers; copying just `midnight.exe` is insufficient.

For an isolated review of that historical artifact, first close the installed Midnight through its tray menu. Run PowerShell from the repository root and resolve the artifact before creating a fresh profile:

```powershell
$reviewExe = (Resolve-Path -LiteralPath '.\release\goal-packaging-v0.5.0\win-unpacked\midnight.exe' -ErrorAction Stop).Path
$reviewProfile = Join-Path $env:TEMP ('midnight-review-' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $reviewProfile | Out-Null
$env:MIDNIGHT_USER_DATA = $reviewProfile
try {
    Start-Process -FilePath $reviewExe
} finally {
    Remove-Item Env:\MIDNIGHT_USER_DATA
}
```

This creates a separate profile with no existing accounts or prepared model configuration. Connect the desired writing model in that review profile. Whisper/embedding preparation may need to be configured there; isolated qualification profiles had deliberately prepared access to the existing caches. The script does not install the app or delete a profile. The profile path is available in `$reviewProfile`.

For typed help, open an expendable document in the qualified WPS version. Select a paragraph or place the caret in it, press `Ctrl+Alt+Space`, enter “Make this paragraph clearer,” review, and apply. The result offers “Undo this edit”; the tray's “Recent quick edit” entry can reopen the latest receipt. A changed/expired target needs a fresh capture.

For charts, select a supported single-series native bar/column chart, invoke the same shortcut, and enter “Change this chart to pie.” Review the local command and apply it. This does not convert a chart image or qualify linked data.

In that historical build, voice setup was under Settings → General → Voice input: enable voice, prepare Whisper, choose the spoken language, and enable “Hold to speak about the selection.” In v0.6.0, use Settings → General → Help with the selection → “Hold to speak instead of typing”; language and native-media controls remain under Voice input. Hold `Ctrl+Alt+Shift+Space` while speaking about the selected target, then release. Review the proposed change before applying. Keep native cloud hearing disabled for the agreed initial rollout.

For customization, open Settings → Changes, choose Charts or Accent colors, select My Midnight or Official proposal, and describe the change. Refresh to see the preview/checks. “Use this version” activates an exact private candidate. Official proposals expose candidate source for review. Tray → Restore last good plugins restores components without needing model generation.

App source is available only from a matching development checkout with its prepared validation image/dependencies. The packaged option remains gated. A passing source proposal does not change the running app.

## What remains before everyday use

At this phase's exit, the unified “Help with the selection” setup section was still pending. It is now implemented in the v0.6.0 checkout, including shortcut/Office/model status, speech preparation and held-shortcut listener status. Do not reimplement it from this historical task list. The remaining priority is the physical and installed paragraph/chart/voice workflow.

1. Qualify the existing setup section and its actionable failures in the installed workflow. Keep cloud media separate from local speech.
2. Qualify physical keys, a real microphone and foreground capture while typing, switching windows and changing selections. Test both cold and warm Whisper behavior, cancellation, passive results and undo.
3. Qualify Microsoft Word separately, including supported versions and chart/rich-text boundaries. Preserve explicit WPS qualification until that evidence exists.
4. Rebuild the installer from the final directory bytes and qualify an installed upgrade/profile/cache path. Shipping through the signed release workflow is a separate delivery step.
5. Establish repeated latency and CPU/RAM/battery measurements for the actual workflow. A one-sample fixture and a successful startup are insufficient acceptance evidence.

The larger approved scope then continues with:

| Work | Required outcome |
|---|---|
| Installed source and toolchains | A package can obtain its exact trusted source baseline and prepared isolated dependencies before model generation. |
| Candidate Windows build and preview | Compile changed native source, build a candidate, run an isolated app preview, retain the tested exact candidate, and show the user the result. |
| Complete app repair delivery | Review/install a trusted candidate through the official update/recovery path, with compatibility checks and retained rollback information. |
| Wider plugin support | Add useful connectors/tools/workflows/UI contributions, dependency constraints and namespaced state migrations without replacing kernel authority. |
| Recovery expansion | Handle corrupt/legacy container ownership, positive signed installer trust, damaged official code and migration failures through an independent recovery path. |
| Live seeing | Capture only the requested region/object, coalesce events, bound frames/clips and verify native video ordering and audiovisual alignment. |
| Native cloud hearing | Qualify a real account/model on speech, silence, numbers, negation and quality/latency/cancellation before enabling live use. |
| Streaming assistance | Establish bounded incremental media/intent handling without applying partial or obsolete commands. |
| Ambient mode | Explicit enable/disable, visible capture status, app/content exclusions, VAD/wake detection, rate limits and false-activation/bystander tests. |
| Background efficiency | Count the complete owned process tree, native allocations, media buffers and optional executors; establish real pressure/battery behavior and cloud usage budgets. |
| Long-running reliability | Eight-hour work and 24-hour standby runs, privacy traces, lock/resume recovery and statistical responsiveness. |
| Languages and content fidelity | Real working-language/code-switching fixtures, number/name/date handling, broader paragraph structures and chart sources. |

These items preserve the full objective. Native audio/video, real-time background usefulness and installed self-repair are not complete because the foundational interfaces pass.

## Code and evidence locations

| Area | Main locations |
|---|---|
| Shell invocation and dedicated UI | `src/main.mjs`, `src/desktop/quick-assist.mjs`, `src/desktop/quick-window.mjs`, `src/quick/` |
| Selected target and narrow writing | `src/context/capsules.mjs`, `src/context/paragraph-format.mjs`, `src/context/proposals.mjs`, `src/runtime/host.mjs`, `src/runtime/adapter.mjs` |
| Native writes and durable effects | `src/desktop/word-broker.mjs`, `src/desktop/native/MidnightWord.cs`, `src/policy/target-edits.mjs` |
| Voice | `src/voice/ptt.mjs`, `src/voice/capture-epoch.mjs`, `src/voice/runtime.mjs`, `src/desktop/ptt-recorder.mjs`, `src/desktop/ptt-hotkey.mjs`, `src/desktop/native/MidnightPtt.cs` |
| Inference and resources | `src/inference/`, `src/resources/profiles.mjs`, `src/scheduler/queue.mjs`, `src/missions/coordinator.mjs` |
| Embeddings | `src/search/native-assets.mjs`, `src/search/native-worker.mjs`, `src/search/runtime.mjs`, `src/search/service.mjs` |
| Deferred native media | `src/perception/`, `src/contracts/`, `src/ui/settings.js` |
| Plugins and activation | `src/plugins/`, `src/desktop/plugin-executor.mjs`, `src/ui/settings.js` |
| Builder and source validation | `src/builder/`, `src/desktop/builder-runner.mjs`, `scripts/core-validation.Dockerfile` |
| Recovery | `src/recovery/`, `src/desktop/recovery.mjs`, `src/desktop/native/MidnightRecovery.cs` |
| Packaging | `scripts/package-files.cjs`, `scripts/after-pack.cjs`, `scripts/installer.nsh`, `package.json` |
| Verification | `test/`, relevant `scripts/*-check.mjs` runners, `reports/checks/` |

Routine checks are `npm test`, `npm run test:ui` and `npm run test:quick-ui`. Native WPS checks use `npm run test:word`. Package verification uses `npm run test:package`. Real cloud/Docker qualifications require their explicitly configured account/cache/toolchain and consume time/API quota; follow their script and tracker prerequisites before rerunning. No repeated full validation was needed for this documentation-only exit.

## Exit state and effort

At the original exit, the checkout contained 41 tracked changed entries and 95 untracked entries before this handoff was added; directory entries were not a total file count. The implementation was uncommitted at that point. It was subsequently committed in `8d7b2e8`, followed by the v0.6.0 version/release-notes commit `b05d911`. This report is not evidence of release publication or installation; those require their own records. No sibling `midnight.server` edit was recorded in this phase.

At closure, the owned checks were terminal, no phase qualification/build command was found running, and the Docker backend was stopped. The installed Midnight and two scratchpad UI reproduction process trees were left running because they were outside this phase's ownership. Caches, source proposals and report artifacts were retained; cleanup of previously rejected temporary profiles was not retried. These are historical observations, not current process or filesystem status.

The elapsed work was spent on substantially more infrastructure and repeated qualification than the first usable milestone needed: native formatting/chart edge cases, durable receipts, recovery, scheduler cancellation/process ownership, plugin isolation, packaging and container/source-worker lifecycle. Individual real source fixtures took roughly seven to fifteen minutes, in addition to source validation and rebuilding. There is no complete per-task wall-time or billing ledger from which to honestly allocate every hour or state a total API cost.

That prioritization delayed the everyday workflow. The next implementation session should close the physical/installed usage gap before expanding source delivery or media architecture. Work stops at this handoff at the user's request; the broader goal remains unfinished.
