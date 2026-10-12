# DigUp study and Windows file search

Reviewed the [soliluqoy/DigUp fork](https://github.com/soliluqoy/DigUp) at commit `6faa29e4c315a3a591de1b41bd78751bdf39588d`, whose README points to [ARahim3/DigUp](https://github.com/ARahim3/DigUp). DigUp is MIT licensed. Midnight's implementation follows its retrieval and interaction patterns; the source checkout in `.reference/` is ignored by git.

## What fits Midnight

DigUp combines normalized semantic vectors with exact words, keeps each file's best page or moment, and stores file metadata and segment locations in SQLite. This fits Midnight's existing selected-folder permissions, SQLite owner, evidence records, agent tools, and tray launcher. Exact words remain useful for names, invoice numbers and error codes. A retrieved passage provides evidence to a mission; it does not become an instruction or a confirmed memory.

Its search panel has a query field, grouped results, selected-result preview, an explanation of the match, and visible word-only or indexing status. Midnight adopts those interactions in **Search files**: arrows select, Enter opens, Ctrl+Enter reveals, and **Use in task** brings the result's path and location into the task box. Search works without a chat account. The existing Windows summon shortcut remains `Ctrl+Win`.

The SwiftUI shell and Apple-specific PDFKit, Vision, AVFoundation, ImageIO and Metal integrations require replacements on Windows. Midnight runs the model with ONNX Runtime through Transformers.js in a worker thread of its engine, decodes media with Chromium's own codecs and pdf.js in a hidden sandboxed window, and stores vectors in SQLite with the sqlite-vec extension and an FTS5 word index. Nothing else needs to be installed: no Python, no PyTorch.

## Model and runtime

The model is **EmbeddingGemma 2** in its ONNX export, `onnx-community/embeddinggemma-2-ONNX`, pinned to a commit and quantized to 8 bits (`q8`, about 850 MB for text, vision and audio; the model card reports at least 0.9997 cosine similarity to full precision). [Google's developer guide](https://developers.googleblog.com/embeddinggemma-2-the-developer-guide/) documents a shared 768-dimensional space for text, code, images, video and audio, with optional smaller vectors. The full model supports all of Midnight's media categories. SearchQuery and Document task prompts distinguish queries from indexed text; visual and audio inputs use the model's media interface. Outputs are normalized before cosine comparison.

The engine sends text to the worker and asks the shell to decode media: images through `createImageBitmap`, PDF pages and their text through pdf.js, video frames by seeking a `<video>` element, and audio through Web Audio resampled to mono 16 kHz. The decoder page receives a file's bytes from the shell and never touches the file system or network. CPU is the default; **Use the graphics card** selects DirectML on Windows, Core ML on macOS or CUDA on Linux and falls back to the CPU. Model revision, quantization, preprocessing version and dimensions identify the index's vector space; incompatible vectors are not compared. Only setup downloads; indexing and search load the saved files with remote access turned off.

Words are matched through an FTS5 index and meaning through sqlite-vec (a vec0 table per vector size); only the resulting candidates are scored and revalidated, instead of scanning every stored passage per query. If the extension cannot load, search scans the stored Float32 vectors instead. Filename discovery is cached and refreshed when a selected folder's modification time changes.

## Windows setup

1. Open Midnight, choose **Search files**, and add the folders you want searchable.
2. Click **Install local search**. This downloads the pinned model (about 850 MB) into app data once.
3. Click **Index selected folders**. Watch progress or stop it from the same surface.
4. Describe a document, picture, sound or video moment. Use the media filters to narrow results.

To recover an incomplete installation, run **Install local search** again (or **Repair local search** for an installed model).

The search panel shows download bytes, model loading and verification, elapsed time, and the current file/page during indexing. Setup errors remain visible until another action is taken. Once installation finishes, it prompts you to choose folders and index them; installation alone does not create an index.

The repository also includes `scripts/setup-search.ps1` for downloading the model from PowerShell into a chosen data directory.

## Coverage and boundaries

Text and Word documents are split into passages; PowerPoint slides contribute extracted text and slide locations. PDFs are indexed by rendered page with available extracted text. Images use their visual contents. Audio uses overlapping 30-second windows. Video uses sampled frames and audio windows. Results retain the source passage, page or timestamp. The sandboxed local preview opens a PDF at its page and seeks supported audio/video codecs to the match. Explorer reveal supports opening formats in another app.

Indexing is explicitly started by the user and bounded by file, depth, size and segment limits. Status reports skipped files and partial coverage. Code repositories, archives, generated files and unsupported formats need their own extraction policies. On Windows, words inside pictures and scanned PDF pages are read with the operating system's own OCR engine (`src/desktop/native/MidnightOcr.cs`, built by `npm run build:native`) and indexed with the passage, so exact words find them too. Automatic filesystem watching, visual slide rendering and DigUp's separate code-search mode are follow-up work. Audio embeddings identify moments without generating transcripts.

Only selected folders are searched. Discovery and reads exclude credential names, hidden/cache/system paths and links; Windows file attributes are checked before reading cloud placeholders. Source identity and folder permissions are checked again before returning or opening a cached result. Removing a source purges its index. **Clear index** and deleting all app data remove indexed contents.

The index and embeddings stay on the computer. Using a result in a task, or invoking `files_search` inside a cloud-model mission, can send the resulting path and excerpt to the selected chat provider. Local or offline missions retain the existing model routing and privacy policy.

## Validation

### Context for the cloud agent

The same local runtime also complements the selected chat model. Confirmed memories, historical task answers, registered skills and reviewed recipes receive cached vectors in SQLite. The cache contains source IDs, content hashes and vectors; source text is read from its owner when retrieved. Background preparation loads the installed model without downloading anything. Chat preflight waits up to 800 ms for a query vector and up to 800 ms for selected-file retrieval; cold or busy workers use word matching. Context is limited to four memories, two past tasks, two workflow suggestions, four files and 10,000 characters of excerpts. These bounds limit added context, rather than establish a total chat token limit.

The recall_context tool lets the agent retrieve further memories and task history. Historical answers are labeled with task IDs, state and date and remain evidence, not confirmed facts. Local/offline history is excluded from cloud missions; page-assistant conversations retain their shared-page boundary. Expired, superseded and unconfirmed memories are excluded. File permissions and historical source lineage are rechecked; removing a source or deleting history prevents it from returning through cached answers. Correction and deletion invalidate owned vectors immediately.

The host selects passages from web pages before returning them to the cloud model. Selection keeps source URLs and nearby paragraphs, has a shared 1.5-second budget per read call, and retains completed semantic matches if later batches time out. Query and passage vectors are bounded in-memory caches. Cancellation discards late responses; foreground deadlines preserve the already-loaded worker while an active batch finishes. The context.prepared events record matching mode, elapsed time, source IDs and character counts without duplicating source text.

The files_view tool renders an image, a PDF page or a video frame from a validated search-result ID in the hidden decoder window and returns that actual image to a vision-capable chat model. It rechecks the source after rendering. Audio retrieval still identifies moments without producing transcripts.

The settings toggle **Relevant context for AI** disables task-context retrieval and semantic web passage selection. File-search installation and its existing selected-folder index remain managed through the search panel. Excerpts sent to a cloud chat model follow that provider's privacy policy.

`npm run test:search-model` (below) also checks agent context: memory relevance, history and passage selection, offline. It measures local retrieval and passage selection; it does not measure answer quality or monetary savings from a real cloud provider.

The synthetic benchmark in scripts/context-benchmark.mjs compares giving the cloud model the full fixture corpus against giving it locally retrieved excerpts. Run it with --cloud to use the app's configured cloud account; it reports input/output tokens, response time and three factual answer checks. It reads account/model settings and the installed model cache, and creates its own task and memory database. It never sends the user's stored work. This small comparison establishes behavior on the fixture, not general quality or latency guarantees.

Automated checks cover retrieval ordering, source mutation and revocation, invalid vectors, cancellation, media locations, trusted IPC, and renderer races/keyboard interactions. Fixtures exercise the whole UI without installing a model. Actual retrieval quality and codec coverage require a configured model runtime and representative local files; fixture success does not establish those measurements.

Run the real model check in Electron. It downloads the pinned model on first use (into `MIDNIGHT_TEST_SEARCH_DATA`, default `~/.cache/midnight-search-model`), creates isolated sample documents, an image, audio and a two-page PDF, indexes them through the real decoder window, and checks semantic retrieval without shared query words, PDF page locations, previews and agent context. It uses a temporary database and does not index personal folders:

```powershell
npm run test:search-model
```
