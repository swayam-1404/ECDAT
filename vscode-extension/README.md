# ECDAT VS Code Extension

This extension runs the ECDAT cryptographic detector locally and shows findings directly in VS Code. Source text is passed only to the local Python process and is not sent to an external service.

## Features

- Scan the active file from the Command Palette or editor context menu
- Scan supported files automatically when they are saved
- Show risk findings on the correct line and in the Problems panel
- Scan the complete workspace with progress feedback
- Run the complete OpenSSL-backed engine across source, binaries, certificates and keys in the workspace
- Select repository archives, binaries, certificates, keys or container-image archives for a full local scan
- Show OpenSSL, Syft and Trivy engine details in the report
- Open a local cryptographic report inside VS Code
- Export the current findings as a JSON CBOM
- Detect OpenSSL, PyCryptodome, Python cryptography, Node Crypto, Web Crypto, libsodium, Bouncy Castle and PKCS#11/HSM source usage

## Development setup

From the repository root, install the backend requirements first:

```powershell
python -m pip install -r requirements.txt
```

Then build the extension:

```powershell
cd vscode-extension
npm install
npm run compile
```

Open the repository in VS Code, select the `vscode-extension` folder, and press `F5` to start an Extension Development Host. Open a source file and run **ECDAT: Scan Current File**.

The extension assumes its folder is directly inside the ECDAT repository during development. If it is copied elsewhere without packaging, set `ecdat.engineRoot` to the repository root and `ecdat.pythonPath` to a Python executable with the backend requirements installed.

To build an installable package that includes the local Python scanner:

```powershell
npm run package
```

Install the generated `.vsix` through **Extensions: Install from VSIX**. Python must be available locally, but no ECDAT server is required.

## Commands

- `ECDAT: Scan Current File`
- `ECDAT: Scan Workspace`
- `ECDAT: Scan Binary, Certificate, Key or Container`
- `ECDAT: Show Cryptographic Report`
- `ECDAT: Export CBOM`
- `ECDAT: Clear Findings`

## Prototype limits

Save-time scanning uses the lightweight source detector. Manual workspace and artifact commands use the complete local engine with OpenSSL-backed artifact parsing, binary fingerprints, and Syft/Trivy container analysis. Full scanning requires the Python packages in the root `requirements.txt`; Syft and Trivy must be installed for their container checks. Validate findings before making security decisions. ECDAT never executes project code or scanned binaries.
