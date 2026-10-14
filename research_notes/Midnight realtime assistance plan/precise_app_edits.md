# Precise assistance in active work apps, especially Microsoft Word

> **Historical research — 13 October 2026, before the realtime implementation.** Statements about missing selection/COM/edit support describe the researched baseline, not v0.6.0. The native WPS connector and bounded cloud-writing path have since been implemented; physical workflow and Microsoft Word qualification remain separate. See the [reconciled plan](../../reports/Midnight%20realtime%20assistance%20plan.md) and [current implementation status](../../docs/realtime-implementation.md). Repository links navigate to current files; obsolete source line numbers have been removed.

Research date: 13 October 2026. Scope: read-only repository and primary Microsoft documentation research; no Word launch, desktop interaction, document modification, installation, or app code change. The engineering designs below are proposals, distinguished from verified API facts.

## 1. What already exists in Midnight, and what is missing?

### Takeaway

Midnight already has useful desktop control, foreground identity, on-device OCR, and selected browser text capture. Its current Word support is file extraction/report export, not a semantic connection to the live Word selection or chart; that distinction is fundamental to the requested experience.

### Cited Findings

- Repository guidance contains no extra workflow constraint for this research beyond its attribution rule and vendored package development rule. [CLAUDE.md](../../CLAUDE.md).
- `computer.mjs` runs a persistent PowerShell helper with `-MTA`, hidden windows, timeouts, and a lease epoch fencing input. It remembers the prior foreground app/window and optionally browser URL. [computer.mjs](../../src/tools/computer.mjs), [foreground capture](../../src/tools/computer.mjs).
- Desktop `read_text` requests up to 40,000 characters from the helper and emits at most 30,000; the helper uses `TextPattern.DocumentRange.GetText(max)`, not `TextPattern.GetSelection()`. This is whole-document/control text acquisition, even when the user means one paragraph. [read_text](../../src/tools/computer.mjs), [helper text implementation](../../src/tools/input-helper.ps1).
- Generic `set_value` uses a UIA ValuePattern when available; fallback clicks, sends Ctrl+A, then types. It does not preserve a Word paragraph's rich runs, fields, hyperlinks, comments, or embedded objects. Do not use this operation as the live Word editing contract. [set_value](../../src/tools/computer.mjs), [UIA SetValue](../../src/tools/input-helper.ps1).
- Summoning the capsule calls `noteForeground()` without awaiting it, then shows and focuses Midnight. Capturing a semantic selection before focus transfer therefore needs an explicit new path. [summon](../../src/main.mjs).
- Midnight's built-in browser apps distinguish `selection`, `page`, and `none`, reject navigation/active-app changes during capture, and retain app/profile/URL/title/scope/timestamp metadata. This is a good starting pattern for scope fencing, but applies to Midnight browser views. [capture](../../src/desktop/app-workspace.mjs), [browser page selection extraction](../../src/apps/page-context.mjs).
- The DOCX reader extracts main-body text/headings/tables using ZIP/XML parsing. The writer constructs a new report package. Neither is an in-place, rich-document preservation editor for a live Word document. `chart_create` generates an SVG bar chart and CSV dataset; `report_create` stages a new Word/Markdown report. [DOCX reader](../../src/tools/documents/docx.mjs), [DOCX writer](../../src/tools/documents/docx.mjs), [chart_create](../../src/tools/work.mjs), [report_create](../../src/tools/work.mjs).
- OCR is an existing Windows helper, launched hidden with a timeout. It can supply words from screenshots/files, but does not identify or mutate a native Word chart object. [ocr.mjs](../../src/desktop/ocr.mjs).

### Inferences

- Add `active-context` and app-specific `targeted-edit` plugins behind a core-owned context/operation broker. Reuse the action journal, leases, evidence receipts, model routing, and hotkey system; do not try to turn screenshot clicking or DOCX export into precise live editing.
- Treat screen understanding as an optional interpretation channel. For the paragraph and native-chart examples, the cheapest and most reliable route is app-object metadata plus small selected text, not video or a screenshot passed through a multimodal model. The repository already has enough foreground/hotkey infrastructure to make this incremental.
- A future repair request such as “Midnight replaced too much text” should become a builder task against the connector plugin and a minimal synthetic regression fixture, never a default upload of the user's document.

### Gaps

- No existing Word COM, Office.js add-in, semantic selection API, or native chart conversion connector was found in `src/connectors`, `src/desktop`, or `src/tools` by the searches performed. This is an audit conclusion, not proof about unpublished work elsewhere.
- The installed Word edition/build, bitness, number of simultaneous Word instances, Protected View/IRM restrictions, and add-in deployment policies were not inspected. They remain explicit implementation discovery work; no actual document was read.

## 2. Which Windows/Office integration should we choose?

### Takeaway

For this Windows-first app and the user's two concrete examples, implement a local Word COM broker first, running only in the signed-in user's desktop session. Later add Office.js for portable text assistance and Excel chart support. Word's JavaScript API must not inherit Excel chart promises.

### Cited Findings

- Word Office.js exposes `Document.getSelection()` and `Document.changeTrackingMode`; the latter requires WordApi 1.4. [Word.Document API](https://learn.microsoft.com/en-us/javascript/api/word/word.document?view=word-js-preview).
- Word's range API exposes scoped text/paragraph/font access, `insertText`, OOXML read/write, and object tracking. `getOoxml` is WordApi 1.1, `getRange` is WordApi 1.3; tracking adjusts the object for surrounding document changes, while untracking releases host resources. Numerous tracked objects can slow Word. These capabilities support scoped text assistance, not revision transactions. [Word.Range API](https://learn.microsoft.com/en-us/javascript/api/word/word.range?view=word-js-preview).
- Tracked-change collections and scoped `getTrackedChanges()` were added in WordApi 1.6. They expose author/date/type/text and individual accept/reject. [WordApi 1.6 requirement set](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-1-6-requirement-set?view=word-js-preview), [tracked changes guide](https://learn.microsoft.com/en-us/office/dev/add-ins/word/manage-tracked-changes).
- The current Word JavaScript package catalog contains no `Chart` entry; a browser find for `Chart` returned no match. Meanwhile, Excel Office.js explicitly exposes `Excel.Chart.chartType` in ExcelApi 1.1. This verifies an API-surface distinction, not an assertion that Microsoft can never add Word chart support. [Word package catalog](https://learn.microsoft.com/en-us/javascript/api/word?view=word-js-preview), [Excel.Chart API](https://learn.microsoft.com/en-us/javascript/api/excel/excel.chart?view=excel-js-preview).
- Native Word exposes charts through both `InlineShape.Chart` and `Shape.Chart`. `Selection.InlineShapes` returns selected inline objects; `Selection.ShapeRange` returns selected floating objects. Native Word `Chart.ChartType` is read/write `XlChartType`. [InlineShape.Chart](https://learn.microsoft.com/en-us/office/vba/api/word.inlineshape.chart), [Shape.Chart](https://learn.microsoft.com/en-us/office/vba/api/word.shape.chart), [Selection.InlineShapes](https://learn.microsoft.com/en-us/office/vba/api/word.selection.inlineshapes), [Selection.ShapeRange](https://learn.microsoft.com/en-us/office/vba/api/word.selection.shaperange), [Word Chart.ChartType](https://learn.microsoft.com/en-us/office/vba/api/word.chart.charttype).
- The published `XlChartType` enumeration defines `xlPie` as 5. Use the named enum in the broker and a schema enum such as `"pie"` externally; do not let a model supply arbitrary COM property values. [XlChartType enumeration](https://learn.microsoft.com/en-us/office/vba/api/excel.xlcharttype).
- PowerPoint's native `Chart.ChartType` is also read/write. This supports a later native PowerPoint adapter but does not establish a PowerPoint Office.js chart conversion API. [PowerPoint Chart.ChartType](https://learn.microsoft.com/en-us/office/vba/api/powerpoint.chart.charttype).
- Office COM object models are not thread-safe; Office runs in a main STA. Calls can block or be rejected when Office is busy or showing modal UI. Microsoft describes STA worker setup, COMException handling, and message filters/bounded retries. [Office threading support](https://learn.microsoft.com/en-us/visualstudio/vsto/threading-support-in-office?view=vs-2022).
- Microsoft does not support Office automation from unattended, non-interactive contexts such as NT Services. Background presence in a signed-in desktop app must not be confused with a Windows service that controls Office without an interactive user. [Unattended Office automation considerations](https://learn.microsoft.com/en-us/office/client-developer/integration/considerations-unattended-automation-office-microsoft-365-for-unattended-rpa).
- Windows UIA text ranges can get text, selections, attributes, surrounding text units, and embedded-object elements; availability and detail depend on the target provider. The documented manipulation methods navigate/select ranges; they do not constitute a general rich-text insertion or chart-type API. [UIA text range objects](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-usingtextrangeobjects).

### Inferences

Recommended connector hierarchy:

| Route | Read capability | Write capability | Proposed role |
|---|---|---|---|
| Word COM, local user session | Selected live range and native inline/floating chart | Native range mutations and chart type | Windows MVP; works on unsaved live state |
| Office.js Word add-in | Selected range, style, scoped OOXML, revisions if supported | Targeted text patches, optional tracked changes | Portable text route; separately deployed/activated |
| Office.js Excel add-in | Selected range/active chart and workbook object metadata | Native chart type and range operations | Best portable Excel route; not a Word-chart bridge |
| UI Automation | Provider-exposed selection/caret/text and control metadata | Control-specific actions; text writes limited | General-app read fallback and small proven app-specific recipes |
| Screenshot crop / OCR / visual model | Visible region only, with uncertainty | UI recipe if explicitly supported and verified | Last resort; prefer suggestion when target semantics are unknown |
| DOCX file tools | Saved file only | New report/export or offline copy | Separate artifact workflow; never overwrite a live open DOCX to simulate targeted editing |

The native broker should be a small C# executable with a dedicated STA thread, message pump, and serialized commands. The existing MTA PowerShell desktop helper is not the right thread/container for Word COM. The broker attaches only to the intended existing interactive Word instance, verifies process/window/document identity, and exposes a narrow protocol. It must not launch Word in a Windows service, run generated VBA, evaluate arbitrary COM expressions, or permit generic PowerShell from the text model. Match the active instance/window reliably rather than assuming the first active Word COM instance is the correct document. Bound retries on busy calls; model inference occurs outside COM calls.

Native plugin activation can be shipped as an optional bundled helper enabled when the user chooses Word assistance, without a mandatory Word add-in for the MVP. Office.js remains a separate optional add-in path with a feature/capability matrix. Its local connection needs authenticated, origin-validated transport; no unauthenticated localhost endpoint that any website can use to request edits. A Word add-in could offer a small ribbon/context-menu command for selection assistance; Midnight's global hotkey/PTT remains the initial activation route.

### Gaps

- None of the cited APIs documents a universal atomic compare-and-swap operation for a Word range. Treat a local precheck/mutate/postcheck sequence as conflict detection with a narrow race window, not a transaction guarantee.
- Need a proof of concept for attaching to the foreground Word instance under multiple processes/windows, 32/64-bit Office, modal dialogs, coauthoring, Protected View, and protected/locked ranges. This is a release gate, not justification to switch to unsafe file rewrites.
- Need to test chart/undo behavior on supported Office builds and representative chart types. API access exists; fidelity, eligibility, and exact undo grouping require experiments.

## 3. How should versions and deployment affect promises?

### Takeaway

Expose granular capability checks such as `selectedText.read`, `plainParagraph.patch`, `richRuns.patch`, `nativeChart.convert`, `trackedChanges`, and `undo.group`. A plugin declares capabilities only after runtime detection and tested host support; “Office integration installed” is too coarse.

### Cited Findings

- Microsoft recommends manifest requirements or runtime requirement-set checks. For Windows subscription/retail clients, the published matrix gives WordApi 1.1 at version 1509/build 4266.1001, 1.3 at 1612/build 7668.1000, 1.4 at 2208/build 15601.20148, and 1.6 at 2308/build 16731.20234. Perpetual/LTSC support differs. WordApiDesktop 1.2 starts at 2502/build 18526.20144 and is unavailable in the listed volume-licensed perpetual column. [Word requirement sets](https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-requirement-sets?view=word-js-preview).
- Native Word `Range.Duplicate` makes an independent range object whose endpoints can change without changing the original. `Range.Text` is plain/unformatted and replaces existing text; `Range.FormattedText` copies character formatting and includes paragraph formatting when the paragraph mark is in range. These are useful building blocks, not a guarantee that a whole-paragraph plain-text replacement preserves all rich structures. [Range.Duplicate](https://learn.microsoft.com/en-us/office/vba/api/word.range.duplicate), [Range.Text](https://learn.microsoft.com/en-us/office/vba/api/word.range.text), [Range.FormattedText](https://learn.microsoft.com/en-us/office/vba/api/word.range.formattedtext).
- Native Word's `Application.WindowSelectionChange` fires on changes in the active document window's selection. It is not documented as a complete revision counter for every content/coauthoring change. [WindowSelectionChange](https://learn.microsoft.com/en-us/office/vba/api/word.application.windowselectionchange).
- Current Office add-in keyboard-shortcut documentation lists Word on Windows support from version 2408/build 17928.20114, requires SharedRuntime 1.1, and requires KeyboardShortcuts 1.1 for user customization. [Office add-in keyboard shortcuts](https://learn.microsoft.com/en-us/office/dev/add-ins/design/keyboard-shortcuts).
- Shared-runtime add-ins can retain state/listeners while the task pane is hidden. As of 23 February 2026, `showAsTaskpane()` is ignored for Marketplace-published add-ins and applies to centrally deployed or sideloaded add-ins. This deployment detail matters if future designs depend on programmatically opening the pane. [Show/hide task pane](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/show-hide-add-in).

### Inferences

- Do not require the latest WordApiDesktop set just for text selection. Start the add-in text route with WordApi 1.1 capabilities, enable more exact range handling when 1.3 exists, optional tracking controls at 1.4, scoped revision APIs at 1.6, and use `Office.context.requirements.isSetSupported` per optional feature. Avoid preview-only API dependence for the production MVP.
- Do not advertise hidden, always-live add-in listeners as universal across every Office edition/deployment. Word's host runtime lifecycle and policy must be tested. A tray supervisor and on-demand COM attach avoid making this the MVP dependency.
- Scope identifiers are opaque broker-owned handles. An Office.js tracked range and COM duplicated range may move with surrounding edits; both still need identity and current-content checks. Bookmarks/content controls should not be inserted silently merely to locate a target because that changes the document before the requested edit.

### Gaps

- The official requirement-set page contains legacy minimum rows while its general support language names newer Office editions. Runtime detection and actual supported-build testing should decide shipment support; a minimum API row is not a recommendation to support an out-of-support Office version.
- No universally guaranteed Office.js undo-group/CAS API was established by this research. The portable route must document its tested undo behavior, or rely on an explicit reversible connector patch with matching-current-state checks.

## 4. What should the minimal context and edit contract contain?

### Takeaway

Freeze the target when the hotkey/PTT is pressed, before focus moves. Send the model a small semantic envelope, while the broker retains protected native handles and fidelity snapshots locally. The model returns a typed operation, not a new document or arbitrary automation program.

### Cited Findings

- The existing browser app capture already checks active-app identity and document navigation generation before/after reading, and carries scope/timestamp metadata. [app-workspace capture](../../src/desktop/app-workspace.mjs).
- Word provides independent native ranges and selected native shape collections; Office.js provides selected ranges and scoped structured representations. These are the available foundations for freezing a target independently of subsequent UI selection. [Range.Duplicate](https://learn.microsoft.com/en-us/office/vba/api/word.range.duplicate), [Selection.ShapeRange](https://learn.microsoft.com/en-us/office/vba/api/word.selection.shaperange), [Word.Document](https://learn.microsoft.com/en-us/javascript/api/word/word.document?view=word-js-preview).

### Inferences

Proposed broker-side context capsule:

```json
{
  "requestId": "opaque-id",
  "adapter": "word-native",
  "app": { "processId": 0, "windowId": "opaque", "hostVersion": "detected" },
  "document": { "instanceId": "opaque-session-id", "displayName": "Draft", "saved": false },
  "target": { "handle": "opaque-native-handle", "kind": "paragraph", "story": "main", "selectionMode": "explicit", "beforeHash": "...", "structureHash": "..." },
  "observed": { "capturedAt": "...", "contextGeneration": 0, "expiresAt": "..." },
  "context": { "selectedText": "...", "nearbyText": "bounded-if-needed", "style": "Body Text", "structureFlags": [] },
  "grant": { "readScope": "target-only", "writeScope": "target-only", "operations": ["text.patch"], "maxExpansion": "none" }
}
```

The numeric values above are placeholders. `beforeHash` is computed over the captured selected text, and `structureHash` covers the target's relevant runs/object metadata. Neither requires hashing or loading the whole document. `contextGeneration` is a broker observation sequence, explicitly not a complete Word revision number. COM/Office.js handles stay outside the model; no access to other documents merely because the target application has them open.

Proposed budgets and semantics:

- Default selected text only, request words, host capability summary, and minimal style/structure flags. A proposed paragraph budget is 800-1,500 input tokens including prompt/metadata; use zero history/file-memory recall for the quick edit. Budget the full input actually tokenized, not just selected characters. A separately offered “consider surrounding paragraphs” can read at most one neighbor each side if necessary and authorized.
- A caret-only “improve this paragraph” may resolve exactly the enclosing paragraph and visibly label the target. “Improve this” with no resolvable paragraph/object is ambiguous; ask for selection rather than read a document. A partial text selection stays partial unless the instruction names the entire paragraph and the user sees that expanded scope.
- Do not silently include hidden comments, tracked-deleted text, surrounding tables, unrelated embedded worksheets, or entire document OOXML. Keep any fidelity snapshot encrypted/ephemeral in the local broker, serialize only allowed model context. Native XML can contain package/relationship material beyond visible text; parse and minimize it before model exposure.
- For plain paragraphs: model returns proposed text or token/character-aligned patch; deterministic local code computes the minimal accepted edit. Preserve paragraph/end-cell marks, paragraph/list style, section boundaries, and unaffected rich runs. A run-aware adapter is required before directly editing mixed-format content. Rewriting prose does not establish a safe mapping for bold/italic/citations/fields: if mapping is ambiguous, show a suggestion rather than flatten formatting.
- For charts: model/router resolves a structured `chart.setType` operation with target handle, expected current type, requested type, and no data mutation permission. The native adapter reads the selected chart's type/series/category/value metadata sufficient to check eligibility, not the document body or entire embedded workbook. If the command is deterministic (“make selected chart pie”), skip generative inference after intent parsing.
- Selection/focus changes after capture do not retarget the task. Before applying, resolve the original handle in its original document, re-read target hashes and structure, check protection/expiry, and cancel or offer updated preview if target changed. If the document closed or target disappeared, abandon the write. If the user switched apps, store the suggestion for return rather than suddenly bring Word to front or mutate a different selection.
- Never call the offline DOCX writer to overwrite the path of an open unsaved Word document. Saved file state is not authoritative for the live app. Unsupported/read-only/protected targets yield an unobtrusive suggestion or specific explanation with the document untouched.

### Gaps

- Exact rich-run mapping strategy is engineering work. MVP can restrict direct edits to one plain paragraph and include rich-content fixtures as refusal/suggestion tests; wider fidelity support follows explicit adapter milestones.
- TTL and token budgets are proposed defaults. They need measurement and usability validation; do not market them as measured performance.

## 5. What do the paragraph and chart journeys look like?

### Takeaway

Make requested small changes cheap and reversible, using an unobtrusive HUD that does not steal focus for voice activation. A paragraph proposal should display the local diff; an explicit chart command can apply a verified native property change and show one-click Undo.

### Cited Findings

- Microsoft describes pie charts as appropriate for one data series representing parts of a whole, nonnegative data, few zero values, and generally no more than seven categories for readability. The seven-category guidance is a recommendation, not a hard API limit. [Add a pie chart](https://support.microsoft.com/en-us/excel/add-a-pie-chart), [Chart types/data suitability](https://support.microsoft.com/en-us/excel/get-started/create-a-chart-from-start-to-finish).
- Word's native chart-type property changes the existing chart object; it need not create a replacement SVG or a new report. [Word Chart.ChartType](https://learn.microsoft.com/en-us/office/vba/api/word.chart.charttype).

### Inferences

**Paragraph example:**

1. The user highlights one paragraph in Word, presses PTT, and says “make this warmer and shorter.” Midnight snapshots the range before another app receives focus; a small listening indicator confirms the target.
2. The broker sends only the selection and minimal style metadata to a warm local text model. Names, dates, numbers, and citations are marked as preserve unless the user instructed otherwise. No whole-document ingestion or broad recalled memories.
3. The HUD shows a concise diff anchored near the selection or a fixed small corner. It does not replace Word's UI or require opening full chat. A user preference may permit immediate application for narrow explicit rewrites; otherwise one shortcut accepts the proposal. Reject/escape leaves Word unchanged.
4. The broker revalidates the original target, applies only accepted text spans, preserves structural delimiters/styles, verifies the result, and stores a receipt. If the user edited this paragraph meanwhile, offer rebase/retry on the newly captured paragraph instead of overwriting their work.
5. Show “Paragraph updated · Undo” without moving the caret/selection unnecessarily. Native Ctrl+Z behavior is tested separately. Avoid background suggestions while the user is actively typing; opt-in ambient mode may queue one quiet suggestion, never auto-edit.

**Native chart example:**

1. The user selects an actual Word chart and says “change this bar chart to pie.” The adapter identifies whether selection is an inline chart or floating shape containing a chart, validates exactly one target, and records its current type/identity/size/position/anchor/title/source metadata.
2. If the selected item is a picture of a chart, expose “This is a picture; provide the source chart/data to edit it” and leave it intact. Visual reconstruction is a separate requested operation, never silently equated to native conversion.
3. For a single suitable series, change that chart's native type property. Preserve chart object identity, anchor, dimensions, title, series/categories/values, and data link where supported. Axes and bar-only styling necessarily change/disappear; do not promise every old chart formatting property survives a type conversion.
4. If there are multiple series, ask a short target-specific choice such as “Use Revenue, use Profit, or keep the multi-series chart?” Do not discard extra series or aggregate values without instructions. For negative/all-zero/non-whole data, explain the incompatibility and leave unchanged. More than seven categories can prompt a lightweight readability suggestion, not a fabricated API failure.
5. Verify new type and unchanged data/object placement; show “Chart changed to pie · Undo.” Do not open the embedded workbook or call data-edit APIs solely to set type. If a busy/error call has uncertain outcome, inspect the existing target state before further actions.

Activation UX should distinguish the tray supervisor from expensive inference. Hotkey/PTT first (the user's stated preference); no continuous screen/video inference for these actions. Global hotkey may briefly focus a tiny text command box by user intent, but target capture precedes focus transfer. PTT can remain fully non-activating. Ambient mode is an explicit later opt-in per app/surface with pause, quiet hours, typing suppression, deduplication, and a strict suggestion rate.

### Gaps

- Need host testing for charts with linked data, custom styles, combinations, nested/grouped shapes, and uncommon 3D/chart variants. Restrict the initial converter to tested 2D single-series bar/column charts.
- Semantic suitability of a pie chart cannot always be decided from values alone. Do not infer that any positive dataset represents shares of a meaningful whole; preserve the user's explicit intent and ask only when conversion would discard/change data.

## 6. How do receipts, undo, tests, and rollout make this reviewable?

### Takeaway

Precise help should be a typed, versioned action with target-local preconditions, postconditions, and conservative retry/undo behavior. Its trust depends on changed scope and fidelity; model fluency alone is not a success metric.

### Cited Findings

- Word exposes `Application.UndoRecord` and `StartCustomRecord`/`EndCustomRecord` for named native undo records. The documentation says a record covers all actions done to the application while active. Keep records around short synchronous mutation code only; never around inference, user review, or an awaited network request. [Application.UndoRecord](https://learn.microsoft.com/en-us/office/vba/api/word.application.undorecord), [StartCustomRecord](https://learn.microsoft.com/en-us/office/vba/api/word.undorecord.startcustomrecord).
- Office can reject/block calls when busy, and Word's range APIs describe plain text replacement and rich formatting separately. These facts justify explicit outcome verification and fidelity limits. [Office threading](https://learn.microsoft.com/en-us/visualstudio/vsto/threading-support-in-office?view=vs-2022), [Range.FormattedText](https://learn.microsoft.com/en-us/office/vba/api/word.range.formattedtext).

### Inferences

Proposed receipt fields: request/intent ID; idempotency key; adapter/plugin version; app/window/document instance; opaque target locator; input text/structure hashes; authorized operation/scope; before/after state hashes; timestamps; native verification result; status (`prepared`, `applied`, `verified`, `conflict`, `outcome-unknown`, `reverted`); undo capability and protected local snapshot reference. Do not copy full document content into logs. Small target content used for undo has a disclosed retention/clear policy.

Every duplicate request with the same idempotency key returns its known receipt. On a worker crash or busy timeout, a supervisor first reconciles target current state with expected pre/poststate; it must not assume the mutation failed or apply it again blindly. If neither state matches, record uncertainty and avoid further write until the user resolves the target. State-based reconciliation prevents many duplicate effects; it is not a promise of exactly-once behavior across a nontransactional Office boundary.

Undo choices:

- Native one-step Ctrl+Z where the adapter/host operation has been tested and grouped. Because custom records encompass application actions, concurrent typing may contaminate a record; test this and keep the broker commit short. Do not block the user's app through long inference.
- Midnight Undo as a reverse patch only if the current target still matches the receipt's poststate. Never call blind `Application.Undo()` later and accidentally undo unrelated user actions. If the target changed, show a reversal diff instead of clobbering later work.
- Chart reversal checks current type/data/object state and restores the tested relevant prior type/format snapshot. Some chart-type changes can drop chart-specific formatting; if full reversal isn't verified, disclose limited undo and restrict direct conversion until fixed.
- Track Changes respects the document's existing tracking setting. If the user explicitly enables revision mode, make a narrow edit; avoid toggling global tracking around a long operation or accepting/rejecting unrelated existing revisions. It does not replace receipt verification.

Suggested implementation gates:

1. **Protocol and synthetic fixtures:** implement read-only semantic capture; exact doc/window matching; context budgets; hashes/TTL; plain paragraph and native chart capability detection. Fixtures are created solely for tests, with no user document data.
2. **Word paragraph MVP:** one plain selected paragraph, local small text route, in-HUD diff, accepted patch, conflict checks and validated native/connector undo. Unsupported rich content gives a suggestion.
3. **Word chart MVP:** tested native single-series 2D bar/column to pie conversion; object/data/title/anchor/size checks; no workbook regeneration; strong image/multiseries refusal handling.
4. **Rich text and additional apps:** run-aware editing, hyperlinks/fields/revisions, Excel add-in/native charts, PowerPoint native charts, optional Office.js Word text route. Publish a capability matrix rather than a broad “can edit Office” claim.
5. **Ambient and repair loop:** opt-in semantic metadata listeners that do not read every paragraph; quiet suggestions; plugin repair via isolated builder and synthetic replay fixtures; compatibility/rollback built into the app plugin contract.

Meaningful acceptance checks:

| Case | Pass condition |
|---|---|
| 30-page document, one selected paragraph | Model payload contains only selected text/minimal allowed metadata; no whole-document/file read tool call |
| Selected subspan vs paragraph vs caret | Actual changed range follows declared target resolution exactly; paragraph/end-cell delimiters survive |
| Bold/italic/hyperlink/field/revision/table content | Untouched structure survives; unsupported mapping produces suggestion, not flattened replacement |
| User edits/moves caret/switches window/closes doc during inference | Original target stays frozen; stale/closed target is not written; focus is never forced back |
| Two Word instances or identically named unsaved docs | Exact captured document/window is targeted; ambiguous attachment refuses to write |
| Native inline and floating chart | Type changes on same object; series/categories/values/title/anchor/geometry remain within tested expectations |
| Image of chart or multiseries/negative dataset | No invented native object/data mutation; intact document and concise next action |
| Busy Word / modal / worker crash / duplicate key | Bounded wait; reconciled poststate; no blind replay; correct unknown-state receipt |
| Undo after unrelated user edit | No unrelated action reversed; stale reverse patch produces diff/conflict |
| Privacy | Context expansion is enforced by broker, not merely prompt; raw rich snapshots never sent to model by default |
| Nonintrusive UX | PTT does not steal focus; no continuous screenshots; background suggestions rate-limited and opt-in |

Performance targets should be published as hypotheses until benchmarked on the user's actual hardware: warm semantic target capture/verification should be measured separately from ASR and first text token; deterministic chart conversion should avoid generative decode. Record median/p95 command-to-capture, end-of-speech-to-intent, first-suggestion, verification/apply, and undo latency plus Word typing responsiveness. Observe idle CPU, wakeups, memory, and energy with no work active. Enforce one generative job at a time initially and cancel stale jobs; users can accept a proposal while continuing their work.

### Gaps

- No latency, energy, capture fidelity, native-undo atomicity, or Word compatibility measurements were run. Values elsewhere in the overall plan must be labeled goals until measured.
- Native Word receipts cannot establish a guaranteed global document revision or atomic transaction from the cited APIs. Scope tests can compare complete synthetic fixture document structure before/after; production should avoid full-document capture simply to prove a small target edit.
