# Repository and UX review of final rebuild plan

Reviewed 2026-10-12 against repo_ux.md. Production code was not edited. Final review completed through section 9; writer is applying the already-identified clarifications.

## Initial saved sections 1–4

- Sound choices: retain Electron/desktop capsule, current palette and app-owned authority; single winning runtime; actual terminal/coding gap explicitly addressed; no arbitrary UI framework or mass TypeScript rewrite; real platform support separated from installer targets; paused/running/unknown outcomes distinguished in prose.
- **Clarify §1.1:** ADR 0002/provenance establish current upstream tarballs, but do not supersede the applicable CLAUDE.md instruction to build/vendor/install after changing sibling midnight.server. Describe that as the retained optional fork workflow; fix stale README claims without implying the instruction is obsolete. Sent to writer and parent.
- **Clarify §3.2 / UI delivery phase:** current `test/architecture.test.mjs:40` disallows all renderer imports and current index.html loads classic scripts. Proposed `src/ui/views`, `components`, `state` modularization should deliberately select native local ES modules or a bundle, update that guard to prohibit privileged/Node imports rather than all imports, and preserve CSP, sandbox and narrow preload. Sent to writer and parent.
- **Validation:** on the initial 46,533-byte draft, a read-only native PowerShell relative-link check found no nonexistent local Markdown targets and no U+FFFD replacement characters. PowerShell Get-Content console mojibake is not evidence of file corruption; use UTF-8 ReadAllText for checking.
- The initial saved file ended after §4.6 with a placeholder for UX/delivery/decisions/evaluation, so no completion claim was made before those sections existed.

## UI review through section 5.4

UI review on the 57,867-byte draft passed: exact palette, warm dot, shadow, radii, fonts and dimensions match source; compact capsule identity survives with optional expanded workspace; contrast measurement is accurately bounded; shortcuts are simplified while retaining accessible controls, IME and terminal focus; refined Escape, Pause, Cancel, Take over and Emergency stop meanings are distinct; WCAG target-size wording correctly avoids labeling 26px icons automatic failures. No required UI correction. Optional improvement sent writer: expanded workspace should avoid unexpected always-on-top occlusion while preserving default capsule behavior. The complete delivery/evaluation/decision tail was subsequently reviewed; outcomes follow below.

## Final delivery, evaluation and traceability review

- Full report reviewed through section 9 at 89,339 bytes. Eleven phases (0-10), eight first-sprint PRs, 36 decision records and a requirements-coverage checklist make the plan actionable and traceable. Roles, dependencies, exit evidence and rollback are explicit. No unsupported whole-project calendar promise or timeline arithmetic contradiction found.
- Evaluation partition sums correctly: 25 browser + 20 desktop + 20 terminal/coding + 15 research/files/artifacts + 10 connector/schedule + 10 cross-surface = 100. Five repeats and at least 30 held-outs are explicitly proposed, not claimed completed.
- Current 8/8 dependency-free test pass, initial missing-typebox load failure, historical 52/52 full tests/11 visuals/23 expected evaluations, and historical idle performance are accurately distinguished. Real desktop/browser execution and best-in-class capability are not falsely claimed.
- Real verifier evidence, false-success measurement, stop feedback versus worker fence acknowledgement, independent adverse fixtures, platform capability gating, signed installed-build checks, old-profile migration and receipt-preserving rollback are included.
- Exact theme preservation, readable semantic contrast, pointer/keyboard/IME access, reduced default shortcuts and focus management are covered by explicit UI gates. ESM/JSDoc-first choice and deliberate renderer import-guard replacement resolve the proposed modularization conflict without requiring a framework or wholesale TypeScript migration.
- Read-only native PowerShell link/encoding check: **0 broken relative local links**, **0 U+FFFD replacement characters**, **8 code-fence markers**, **no synthesis-tail placeholder**. This checks local references only, not live availability of every external web link. Console mojibake from Get-Content was not treated as actual file corruption.

### Small final refinements sent to writer and parent

1. Include the exact fresh test command and Node version in section 7.1: `node --test --test-timeout=60000 test/markdown.test.mjs test/harness-utils.test.mjs test/models.test.mjs`, Node v24.21.0. Supporting notes already contain it; final report should be independently reproducible.
2. PR2 changes persisted verification semantics before PR5's broad migration work. Explicitly require PR2's minimal contract/version-state mapping and migration fixture before emitting new states, with PR5 completing session/recovery migration. This aligns the first-sprint sequence with phase 1 before phase 2.
3. Update final review log to record completed UI review and this full evidence/count/local-link review; remove the log's pending-final-review wording. Add this review file to audit-trail links if useful.

No additional blocking UX, scope-completeness or current-vs-historical evidence issue was found. Earlier CLAUDE-applicability correction remains necessary and was acknowledged by writer as being applied; the native ES module guard correction is already in section 6.1. Backend contract reviewer findings remain their own verification responsibility.