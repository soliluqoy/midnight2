# Midnight

A desktop launcher for asking questions, searching local files, and doing tasks with your chosen AI model. Midnight lives in the system tray and keeps plans, activity, and results in view.

## Install

Download the [latest release](https://github.com/soliluqoy/midnight2/releases/latest), or use the installer:

**Windows x64** — PowerShell, no admin required:

```powershell
irm https://raw.githubusercontent.com/soliluqoy/midnight2/main/install.ps1 | iex
```

**macOS Apple silicon / Linux x64** — terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/soliluqoy/midnight2/main/install.sh | sh
```

Run the installer again to update. Uninstall commands are at the top of [install.ps1](install.ps1) and [install.sh](install.sh). Builds are unsigned; desktop control is currently Windows-only.

## Use

Open Midnight with **Ctrl+Win** on Windows (press both keys, then release), **Cmd+Alt+M** on macOS, or **Ctrl+Alt+M** on Linux. Open Settings to sign in with a supported AI account or add an API key.

- **Ask:** type a question or task. Review action plans and any requests for approval; follow progress and answers in Missions.
- **Files:** search selected folders by words or meaning, then open a result or attach it to a task. Ask drafts and file queries are saved separately.
- **Apps:** pin websites with separate saved sign-ins. Ask Midnight beside a page to summarize or draft from text you choose to share.
- **Context:** retrieve related confirmed memories, previous answers, and selected files for your model. Images, PDF pages, and video frames can be inspected with a vision-capable model.
- **Tray:** drag the title bar to move Midnight; closing it hides it while work continues. The summon shortcut restores it. Use the tray menu to quit.

For local meaning search, open **Files → Manage search**, install local search (a one-time download of about 850 MB; nothing else to install), and index your selected folders. EmbeddingGemma 2 and its index run locally; chat providers receive retrieved excerpts used in tasks. Turn automatic retrieval off in **Settings → Local file search → Relevant context for AI**. See the [local search setup and technical notes](docs/digup-integration.md).

## Develop

Use Node.js 24:

```sh
npm ci
npm start
```

```sh
npm test              # Unit, integration, recovery, and policy checks
npm run test:ui       # Launcher interactions and async races
npm run test:apps     # Website profiles, page sharing, and IPC
npm run test:smoke    # Real app startup with a disposable profile
npm run test:visual   # Screenshots against local baselines
npm run dist          # Package the current OS into release/
```

Pi SDK packages are pinned to upstream 1.0.1 and vendored in `vendor/`. See the [dependency decision](docs/adr/0002-dependencies.md) for provenance and refresh commands. Sign-ins share `~/.midnight.server/agent/auth.json` with the midnight.server CLI.

Pushing a `v*` tag runs checks, builds Windows x64, macOS arm64, and Linux x64 packages, and publishes a GitHub release.
