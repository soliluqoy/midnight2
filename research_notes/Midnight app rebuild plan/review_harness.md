# Harness review of rebuild plan

Reviewed 2026-10-12. Scope: opening and sections 1–2 of `reports/Midnight app rebuild plan.md` while later sections were being written. Read-only review of report; no new web research or benchmarks. Compared with `harnesses.md` and previously fetched primary sources.

## Required corrections

1. **High — evidence status, opening paragraph.** Snippet: “initially retaining the qualified 1.0.1 pin”. The repository selects/pins 1.0.1 and records a limited local runtime spike; this research did not freshly or comprehensively qualify it. Replace with “initially retaining the current ADR-selected 1.0.1 pin pending renewed qualification”. Later disclaimer is correct but does not cure the leading overstatement. Sent to writer and parent.

2. **High — impossible stop guarantee, section 1.4.** Snippet: “no effect after lease revocation”. An already-dispatched external request may complete after stop; section 2.4 correctly explains that. Replace with “no new dispatch after lease revocation; stop and reconcile already-dispatched effects”. Gate should assert no fresh worker action admitted under an old epoch, not that every in-flight real-world effect can be recalled. Sent to writer and parent.

## Completeness improvements

3. **Medium — adapter continuation contract, section 2.2.** The proposed RuntimeAdapter exposes start/steer/requestStop/dispose, but MissionInput's described fields do not specify how the prior Pi session is selected/restored after restart. Add an opaque `sessionRef`/resume option (or explicit restore/open method), adapter identity/version, and a defined durable session-reference/checkpoint event. State that start opens the chosen persisted conversation after broker reconciliation and does not replay historic tools. This closes the seam needed by section 2.3 without exposing engine internals to the coordinator.

4. **Low — fork existence wording, section 1.1.** Snippet: “the preserved credential location does not imply that a fork still exists”. Local ADR proves the current shipping dependency is upstream; it does not prove the historical sibling repository no longer exists. Replace with “does not mean Midnight still ships a forked runtime”.

## Verified accurate in this draft

- Correct Pi canonical repository/namespace, current app 1.0.1 pin versus observed available 1.1.0, and current-main documentation compatibility caveat.
- Correct OMP project identity; observed release versus inconsistent retrieved main manifests is presented as unresolved, not a publication defect.
- Correct Bun requirement and isolated RPC recommendation; custom JSONL, framing and settlement semantics are qualified.
- Correct single production engine and Midnight-owned policy/journal/verification division; no claim that utility processes or tool hooks are OS sandboxes.
- Correct distinction between Anthropic's specific third-party login restriction and OpenAI's supported partner integration route; API-first recommendation does not overgeneralize provider terms.
- Good limitations on exactly-once effects, retry fingerprints, optional external specialists, native Windows packaging, measured superiority and model/cost parity.
- No feature ranking or claimed benchmark win is invented. Alternatives are appropriately classified and bounded.

## Final recommendation

Accept the core choice and comparison after correcting items 1–2 and clarifying the persistence seam in item 3. No new research is required for those corrections. Recheck newly added qualification/decision tables for the same “current pin versus newly qualified” and “dispatch versus completed effect” distinctions.
