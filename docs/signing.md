# Signing and release integrity

## What protects an installed midnight

- **Electron fuses** (`scripts/after-pack.cjs`, run by electron-builder before signing): RunAsNode, `NODE_OPTIONS`
  and `--inspect` are off, so `midnight.exe` cannot be used as a plain Node.js; the app loads only from `app.asar`;
  cookies are encrypted with the OS key store.
- **ASAR integrity**: the archive's hash is embedded in the executable; a changed archive stops the app at start
  ("ASAR Integrity Violation"). Native pieces that other programs or the OS load from disk are unpacked next to it:
  `*.node`, `*.dll`, the helper `*.exe` and `*.ps1` files, sqlite-vec and ONNX Runtime.
- `GrantFileProtocolExtraPrivileges` stays on because midnight's own pages load from `file://` inside the archive;
  turning it off needs the UI served from a custom protocol first.
- **Updates** install only an installer whose SHA-512 matches the release manifest and whose Authenticode signer
  is the same publisher as the running app (`trustedInstaller` in `src/desktop/updater.mjs`). Unsigned builds never
  auto-install.
- **CI**: actions are pinned to commits, jobs get least privilege, release assets carry GitHub build provenance
  (`gh attestation verify <file> --repo soliluqoy/midnight2`), and releases are created as drafts.

`node scripts/smoke.mjs --packaged release/win-unpacked/midnight.exe` checks a build: fuses, archive, the native
Ctrl+Win listener, sqlite-vec, ONNX Runtime, the media decoder and OCR. CI runs it for every Windows build.

## Windows: Azure Artifact Signing (formerly Trusted Signing)

1. Create an Artifact Signing account and a public-trust certificate profile in Azure (identity validation is
   required; availability depends on your country).
2. Create an app registration with a federated credential for this repository's GitHub Actions (OIDC), and give it
   the *Artifact Signing Certificate Profile Signer* role on the profile. No client secret is needed.
3. Set these repository **variables** (not secrets): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`,
   `AZURE_SIGNING_ENDPOINT` (for example `https://eus.codesigning.azure.net/`), `AZURE_SIGNING_ACCOUNT`,
   `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER` (the certificate's subject name).

The release workflow then signs `midnight.exe`, the helper executables (`signExts`) and the installer. Without the
variables builds are unsigned, as before.

## macOS

Builds are not notarized yet. Notarization needs an Apple Developer ID certificate and an app-specific password or
API key in CI; until then `install.sh` clears quarantine and signs ad hoc.
