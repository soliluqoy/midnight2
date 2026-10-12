# Capability architecture adversarial review

Reviewed 2026-10-12 against the first saved report draft (sections 1–2, ending at the synthesis placeholder). Scope: executable contracts, mediation, cancellation, permissions, recovery and rollback. Later capability/UX/roadmap sections were still being written and are not treated as missing requirements. No production edits, installs, model calls or new research were performed.

## Required corrections before finalizing

### R-CAP-01 — Distinguish acknowledgement from independently verified success

**Priority: high. Location: section 2.2 ActionState and ActionReceipt.**

The proposed action state enum jumps from dispatching to succeeded, while the receipt independently permits pending/unavailable verification. That reproduces the current application's central truthfulness gap: successful dispatch can be presented as completed work. It also contradicts section 2.3's promise not to label uncertainty as success.

**Correction:** include `acknowledged`, `verifying`, `verified`, `unknown`, `failed` and terminal denied/cancelled states as needed. Separate executor outcome (`acknowledged`, `failed_before_effect`, `unknown`) from postcondition verdict. An absent verifier yields unavailable/unverified; it cannot satisfy a required verified-effect acceptance check. A reliable tool receipt can be one input to verification, but a click returning without exception proves only that input was attempted. Keep mission success as a separate coordinator decision.

**Acceptance fixture:** a worker returns success but authoritative external state did not change; mission cannot pass. A timeout after actual commit yields unknown then verified only after read-back; it never retries automatically.

### R-CAP-02 — Authorize compound effects and data flows

**Priority: high. Location: section 2.2 ActionIntent.effect.**

A single enum (`read`, `local_write`, `external_write`, `desktop_input`, `process`) cannot describe reading a private file and uploading it, executing a test that starts network children, or typing into an autosaving field. It omits the distinction between account state, destination, credential use, filesystem scope and data transmission. A trusted classifier that emits only one label still has this representation problem.

**Correction:** replace or supplement the enum with a host-derived effect/capability set and explicit `readRoots`, `writeRoots`, `networkOrigins`, `accountId`, `transmittedArtifacts/contentHashes`, `credentialRefs`, `desktopInput`, `remoteMutation`, `irreversibility`, and uncertainty. Require grants for all applicable effects. The model may describe purpose but cannot mint these assertions as authority. Unknown browser/desktop semantics should not downgrade to harmless navigation; the product must use a bounded scope/handoff when it cannot establish a narrower action.

**Acceptance fixture:** authorized local file read plus public browsing does not silently authorize uploading the file. Typing into an autosaving test form is modeled as potential external mutation/transmission before the keystroke.

### R-CAP-03 — Version new contracts without silently rewriting persisted v1

**Priority: medium-high. Location: section 2.2 schemaVersion and MissionState.**

The proposed `schemaVersion: 1` and collapsed states do not match current v1 storage/event meanings. Current states include waiting-input, waiting-approval, waiting-resource, waiting-time, needs-reconciliation and recovering; losing their distinctions can alter recovery/authority semantics. `WorkerEnvelope.protocolVersion:1` can legitimately be a new protocol, but must be distinguished from the persisted domain version.

**Correction:** mark snippets as interface proposals with independent wire versions; evolve canonical domain/event schema through an explicit v2 migration or preserve current names with projections. Add a complete old-to-new mapping, retain waiting subreason and unresolved-action identity, and test pending approvals, paused runs, queued schedules, and unknown actions through upgrade/downgrade. Do not claim normalized illustrative types are already compatible with the current files.

**Acceptance fixture:** a mission waiting for approval remains waiting for that same bound decision, and an unknown external effect remains blocked from replay after migration.

### R-CAP-04 — Separate immediate stopping acknowledgement from actual worker stop

**Priority: high. Location: sections 1.4 and 2.4.**

`No effect after lease revocation` is too absolute: already-dispatched remote changes cannot be recalled, and revoking a local epoch does not synchronously deliver that revocation to a native worker. The text later correctly concedes in-flight effects, but the hard gate and UI acknowledgement language need alignment.

**Correction:** immediately close admission and increment the epoch in the authority process, record `stopping`, and acknowledge the request to the UI as stopping. Deliver native/browser fences through a supervised channel, enforce native monotonic TTL and checks between input primitives, and show stopped/paused only after worker acknowledgement or verified process-tree termination. If termination cannot be established, report degraded/unknown and prevent new ownership of the same resource until reconciled. Distinguish takeover fencing from provider stream cancellation. Proposed 250 ms UI response and two-second termination are measured targets for specified hardware and boundaries, not assurances for all environments.

**Acceptance fixture:** revocation races with a queued input, a running multi-action batch, a hung native helper, and a lost worker channel. No newly admitted primitive executes after the worker acknowledges its fence; any pre-fence action whose outcome is uncertain enters reconciliation. Never assert that UI acknowledgement alone proves no physical input can still occur.

### R-CAP-05 — Rollback must preserve effects performed after the backup

**Priority: high. Location: section 2.3 rollback paragraph and later release plan.**

A compatible old-app/pre-upgrade-snapshot pair avoids schema corruption but may erase receipts for remote sends performed since the snapshot. The old mission could then repeat them. Data compatibility and effect reconciliation are separate rollback requirements.

**Correction:** quiesce before rollback; preserve the newest append-only action ledger, unknown outcomes, recurring execution keys and provider receipts in a forward-readable export or independent compatible store. Record the rollback boundary and import/reconcile post-snapshot effects before admitting any affected mission/routine. If the old app cannot understand that ledger, keep those missions blocked/read-only and use a compatible recovery tool. Preserve post-upgrade artifacts separately too; do not silently discard them.

**Acceptance fixture:** upgrade, successfully send a test message, lose acknowledgement, then roll back. Old-version resume/scheduler must neither forget nor duplicate the send. A successful binary rollback alone does not pass this fixture.

## Clarifications worth adding

### R-CAP-06 — Do not imply universal descendant control in a trusted native process

Section 2.4 says a child cannot launch unsupervised descendants. That is a target enforced by a qualified sandbox/provider, not a property of an arbitrary native program with the user's permissions. Job/process-group supervision covers associated processes; code may call external brokers/services outside that tree depending on OS/security configuration.

State the guarantee for broker-launched managed workers, disable unsupported escape/breakaway paths in sandbox profiles, and keep the trusted-native execution level honestly labeled. Test process-tree cleanup against the chosen Windows/Unix backend. Do not weaken local desktop support merely because generated-code isolation needs a different environment.

### R-CAP-07 — Stable intent identity must survive runs and scheduled invocations

Section 2.3's fingerprint checks should be explicit about scope. A new run, engine session, subagent, or schedule tick must not evade a prior unknown effect. Use workflow/recurrence occurrence plus logical action identity for scheduled idempotency and preserve those identifiers across restart and rollback. Intentional repeated user requests remain allowed with a new verified intention; do not suppress legitimate second actions just because arguments match.

### R-CAP-08 — Tool receipts and tool observations are different payloads

`Tool results re-enter the engine only through broker receipts` should mean a structured broker-approved result envelope containing observations/artifact references and a receipt reference, rather than a small receipt replacing screenshots, extracted page content or terminal output. Trust/source labeling, bounds/redaction, provenance and cancellation status belong in that envelope. This keeps useful context without allowing raw worker output to become instructions or authorization.

## Positive decisions to preserve

- One durable Midnight coordinator and one production runtime adapter; no competing session state authority.
- Provider hooks separated from OS containment; worktrees and profiles are not described as security sandboxes.
- Direct, nested, deferred, codemode, MCP, extension and child-agent execution all required to enter the same dispatcher.
- Exact approval binding, pre-dispatch persistence, unknown-outcome reconciliation, and explicit refusal to promise exactly-once arbitrary external actions.
- Supported authentication eligibility and unknown cost are treated as real integration constraints, not hidden assumptions.
- Pi/OMP trials compare equal tools/models first and treat native-tool differences as a separate experiment.

This review was sent promptly to the coordinator and report writer for the second iteration. Findings describe the reviewed draft; the final report may already incorporate corrections.
