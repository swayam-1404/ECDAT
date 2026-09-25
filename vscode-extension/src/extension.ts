import * as vscode from 'vscode'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

type QuantumDetail = {
  level: string
  reason: string
  x: number | null
  y: number | null
  z: number
  margin: number | null
}

type Finding = {
  id: string
  category: string
  name: string
  file: string
  line: number
  evidence: string
  risk: string
  reason: string
  quantum_risk: string
  quantum: QuantumDetail
  recommendation: string
}

type FileResult = { uri: vscode.Uri; findings: Finding[] }
type EngineResponse = {
  findings: Finding[]
  engines?: Record<string, { available?: boolean; version?: string; provider?: string; scan?: string }>
  input_type?: string
  files_scanned?: number
  files_skipped?: number
}

const supportedExtensions = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs',
  '.php', '.rb', '.cs', '.kt', '.swift', '.yaml', '.yml', '.json', '.xml', '.conf', '.config',
  '.ini', '.env', '.txt', '.md', '.toml', '.properties', '.gradle', '.lock', '.sh', '.ps1',
  '.pem', '.crt', '.cer', '.der', '.key', '.jks', '.keystore'
])

const excludedGlob = '**/{.git,.gradle,.cache,.next,.idea,.vscode,node_modules,venv,.venv,__pycache__,target,dist,build,out,bin,obj,coverage,vendor}/**'
const diagnostics = vscode.languages.createDiagnosticCollection('ecdat')
const results = new Map<string, FileResult>()
let statusItem: vscode.StatusBarItem
let reportPanel: vscode.WebviewPanel | undefined
let lastEngines: EngineResponse['engines'] = {}
let lastInputType = 'source-file'

export function activate(context: vscode.ExtensionContext): void {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90)
  statusItem.command = 'ecdat.showReport'
  statusItem.text = '$(shield) ECDAT ready'
  statusItem.tooltip = 'Open the ECDAT cryptographic report'
  statusItem.show()

  context.subscriptions.push(
    diagnostics,
    statusItem,
    vscode.commands.registerCommand('ecdat.scanCurrentFile', scanActiveEditor),
    vscode.commands.registerCommand('ecdat.scanWorkspace', scanWorkspace),
    vscode.commands.registerCommand('ecdat.scanArtifact', scanArtifact),
    vscode.commands.registerCommand('ecdat.showReport', showReport),
    vscode.commands.registerCommand('ecdat.exportCbom', exportCbom),
    vscode.commands.registerCommand('ecdat.clearDiagnostics', clearAll),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (vscode.workspace.getConfiguration('ecdat').get('scanOnSave', true)) {
        void scanDocument(document, false)
      }
    })
  )
}

export function deactivate(): void {
  diagnostics.dispose()
  statusItem.dispose()
}

async function scanActiveEditor(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showInformationMessage('ECDAT: Open a supported source file first.')
    return
  }
  await scanDocument(editor.document, true)
}

async function scanDocument(document: vscode.TextDocument, announce: boolean): Promise<Finding[]> {
  if (document.uri.scheme !== 'file' || !isSupported(document.uri.fsPath)) {
    if (announce) void vscode.window.showInformationMessage('ECDAT: This file type is not supported.')
    return []
  }
  if (Buffer.byteLength(document.getText(), 'utf8') > 2 * 1024 * 1024) {
    if (announce) void vscode.window.showWarningMessage('ECDAT: Files larger than 2 MB are skipped.')
    return []
  }

  setStatus('$(loading~spin) ECDAT scanning')
  try {
    const response = await runEngine(document.uri, document.getText())
    const findings = response.findings
    lastEngines = response.engines || lastEngines
    lastInputType = response.input_type || 'source-file'
    results.set(document.uri.toString(), { uri: document.uri, findings })
    diagnostics.set(document.uri, findings.map(toDiagnostic))
    updateStatus()
    refreshReport()
    if (announce) {
      void vscode.window.showInformationMessage(`ECDAT: Found ${findings.length} cryptographic item${findings.length === 1 ? '' : 's'}.`)
    }
    return findings
  } catch (error) {
    setStatus('$(error) ECDAT error')
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'ECDAT scan failed.')
    return []
  }
}

async function scanWorkspace(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    void vscode.window.showInformationMessage('ECDAT: Open a workspace folder first.')
    return
  }
  results.clear()
  diagnostics.clear()
  setStatus('$(loading~spin) ECDAT scanning workspace')
  try {
    const response = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'ECDAT full workspace scan · source, binaries, certificates and keys',
      cancellable: false,
    }, () => runEngineRequest({ ...engineOptions(), mode: 'workspace', path: folder.uri.fsPath }))
    results.set(folder.uri.toString(), { uri: folder.uri, findings: response.findings })
    lastEngines = response.engines || {}
    lastInputType = response.input_type || 'workspace'
    const byFile = new Map<string, Finding[]>()
    for (const finding of response.findings) {
      if (!finding.line || finding.file === 'container-image') continue
      const candidate = path.resolve(folder.uri.fsPath, finding.file)
      const relative = path.relative(path.resolve(folder.uri.fsPath), candidate)
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(candidate)) continue
      const items = byFile.get(candidate) || []
      items.push(finding)
      byFile.set(candidate, items)
    }
    for (const [filePath, findings] of byFile) diagnostics.set(vscode.Uri.file(filePath), findings.map(toDiagnostic))
    updateStatus()
    showReport()
    void vscode.window.showInformationMessage(`ECDAT: Scanned ${response.files_scanned || 0} files and found ${response.findings.length} items.`)
  } catch (error) {
    setStatus('$(error) ECDAT error')
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'ECDAT workspace scan failed.')
  }
}

async function scanArtifact(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: 'Scan with ECDAT',
    filters: {
      'ECDAT inputs': ['zip', 'tar', 'gz', 'tgz', 'exe', 'dll', 'so', 'dylib', 'jar', 'war', 'apk', 'pem', 'crt', 'cer', 'der', 'key', 'p12', 'pfx'],
      'All files': ['*'],
    },
  })
  if (!selected?.[0]) return
  setStatus('$(loading~spin) ECDAT scanning artifact')
  try {
    const response = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `ECDAT scanning ${path.basename(selected[0].fsPath)}`,
      cancellable: false,
    }, () => runEngineRequest({ ...engineOptions(), mode: 'artifact', path: selected[0].fsPath }))
    results.clear()
    diagnostics.clear()
    results.set(selected[0].toString(), { uri: selected[0], findings: response.findings })
    lastEngines = response.engines || {}
    lastInputType = response.input_type || 'artifact'
    updateStatus()
    showReport()
    void vscode.window.showInformationMessage(`ECDAT: Found ${response.findings.length} cryptographic items.`)
  } catch (error) {
    setStatus('$(error) ECDAT error')
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'ECDAT artifact scan failed.')
  }
}

function engineOptions(): Record<string, string | number> {
  const config = vscode.workspace.getConfiguration('ecdat')
  return {
    sensitivity: config.get('dataSensitivity', 'pii'),
    migration_complexity: config.get('migrationComplexity', 'standard_application'),
    threat_timeline: config.get('threatTimeline', 15),
  }
}

function runEngine(uri: vscode.Uri, text: string): Promise<EngineResponse> {
  return runEngineRequest({ ...engineOptions(), mode: 'text', path: vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/'), text })
}

function runEngineRequest(payloadObject: Record<string, unknown>): Promise<EngineResponse> {
  const config = vscode.workspace.getConfiguration('ecdat')
  const extensionRoot = path.resolve(__dirname, '..')
  const configuredRoot = config.get<string>('engineRoot', '').trim()
  const bundledRoot = path.join(extensionRoot, 'engine')
  const hasBundledEngine = fs.existsSync(path.join(bundledRoot, 'backend', 'app', 'vscode_bridge.py'))
  const repositoryRoot = configuredRoot || (hasBundledEngine ? bundledRoot : path.resolve(extensionRoot, '..'))
  const python = config.get<string>('pythonPath', 'python')
  const payload = JSON.stringify(payloadObject)

  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      python,
      ['-m', 'backend.app.vscode_bridge'],
      { cwd: repositoryRoot, windowsHide: true }
    )
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
    child.on('error', () => reject(new Error('ECDAT could not start Python. Check the ecdat.pythonPath setting.')))
    child.on('close', code => {
      try {
        const response = JSON.parse(output) as EngineResponse & { error?: string }
        if (code !== 0 || response.error) reject(new Error(response.error || errors || 'ECDAT engine returned an error.'))
        else resolve({ ...response, findings: response.findings || [] })
      } catch {
        const dependencyHint = errors.includes("No module named 'cryptography'")
          ? 'ECDAT full scanning requires the Python dependencies. Run: python -m pip install -r requirements.txt'
          : errors
        reject(new Error(dependencyHint || 'ECDAT returned an unreadable result. Check the engine path.'))
      }
    })
    child.stdin.end(payload)
  })
}

function toDiagnostic(finding: Finding): vscode.Diagnostic {
  const line = Math.max(0, finding.line - 1)
  const range = new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER)
  const diagnostic = new vscode.Diagnostic(
    range,
    `${finding.name}: ${finding.reason} Recommendation: ${finding.recommendation}`,
    severityFor(finding.risk)
  )
  diagnostic.source = 'ECDAT'
  diagnostic.code = finding.quantum_risk === 'not_applicable'
    ? finding.risk.toUpperCase()
    : `${finding.risk.toUpperCase()} / Quantum ${finding.quantum_risk.toUpperCase()}`
  return diagnostic
}

function severityFor(risk: string): vscode.DiagnosticSeverity {
  if (risk === 'critical' || risk === 'high') return vscode.DiagnosticSeverity.Error
  if (risk === 'medium') return vscode.DiagnosticSeverity.Warning
  if (risk === 'low') return vscode.DiagnosticSeverity.Information
  return vscode.DiagnosticSeverity.Hint
}

function isSupported(filePath: string): boolean {
  const fileName = path.basename(filePath).toLowerCase()
  return supportedExtensions.has(path.extname(fileName)) || fileName === 'dockerfile' || fileName === 'requirements.txt'
}

function isProbablyBinary(bytes: Uint8Array): boolean {
  const sampleLength = Math.min(bytes.byteLength, 8192)
  if (!sampleLength) return false
  let controlBytes = 0
  for (let index = 0; index < sampleLength; index += 1) {
    const value = bytes[index]
    if (value === 0) return true
    if (value < 9 || (value > 13 && value < 32)) controlBytes += 1
  }
  return controlBytes / sampleLength > 0.1
}

function allFindings(): Finding[] {
  return [...results.values()].flatMap(item => item.findings)
}

function updateStatus(): void {
  const findings = allFindings()
  const urgent = findings.filter(item => item.risk === 'critical' || item.risk === 'high').length
  statusItem.text = urgent
    ? `$(warning) ECDAT ${findings.length} findings · ${urgent} urgent`
    : `$(shield) ECDAT ${findings.length} findings`
}

function setStatus(text: string): void {
  statusItem.text = text
}

function clearAll(): void {
  results.clear()
  diagnostics.clear()
  updateStatus()
  refreshReport()
  lastEngines = {}
  lastInputType = 'source-file'
}

function showReport(): void {
  if (!reportPanel) {
    reportPanel = vscode.window.createWebviewPanel('ecdatReport', 'ECDAT Cryptographic Report', vscode.ViewColumn.Beside, { enableScripts: false })
    reportPanel.onDidDispose(() => { reportPanel = undefined })
  }
  refreshReport()
  reportPanel.reveal(vscode.ViewColumn.Beside)
}

function refreshReport(): void {
  if (!reportPanel) return
  const findings = allFindings().sort((a, b) => riskRank(a.risk) - riskRank(b.risk))
  const count = (risk: string) => findings.filter(item => item.risk === risk).length
  const engineLabels = Object.entries(lastEngines || {}).map(([name, detail]) => {
    const state = detail.available === false ? 'unavailable' : detail.scan || detail.version || detail.provider || 'ready'
    return `${name}: ${state}`
  }).join(' · ')
  const rows = findings.map(item => `
    <tr>
      <td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)}</small></td>
      <td>${escapeHtml(item.file)}:${item.line}</td>
      <td><span class="badge ${escapeHtml(item.risk)}">${escapeHtml(item.risk)}</span></td>
      <td>${escapeHtml(item.quantum_risk.replace('_', ' '))}</td>
      <td>${escapeHtml(item.recommendation)}</td>
    </tr>`).join('')

  reportPanel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><style>
    :root{color-scheme:light dark}body{font-family:var(--vscode-font-family);padding:24px;line-height:1.5}
    h1{font-size:26px;margin:0 0 4px}.sub{opacity:.7;margin:0 0 24px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:22px}
    .metric{border:1px solid var(--vscode-panel-border);padding:14px}.metric b{display:block;font-size:25px}.metric span{font-size:11px;opacity:.7;text-transform:uppercase}
    table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid var(--vscode-panel-border);padding:10px;text-align:left;vertical-align:top}th{font-size:10px;text-transform:uppercase;opacity:.75}
    td small{display:block;opacity:.65;margin-top:3px}.badge{text-transform:uppercase;font-size:10px;font-weight:700}.critical,.high{color:#e05c63}.medium{color:#d7a13d}.low{color:#47a884}.info{color:#6fa7c7}
    .empty{padding:45px 0;text-align:center;opacity:.7}@media(max-width:800px){.metrics{grid-template-columns:repeat(2,1fr)}table{display:block;overflow:auto}}
  </style></head><body>
    <h1>ECDAT Cryptographic Report</h1><p class="sub">${escapeHtml(lastInputType.replaceAll('-', ' '))}${engineLabels ? ` · ${escapeHtml(engineLabels)}` : ''}</p>
    <div class="metrics"><div class="metric"><b>${findings.length}</b><span>Total findings</span></div><div class="metric"><b>${count('critical')}</b><span>Critical</span></div><div class="metric"><b>${count('high')}</b><span>High</span></div><div class="metric"><b>${results.size}</b><span>Files with findings</span></div></div>
    ${findings.length ? `<table><thead><tr><th>Finding</th><th>Location</th><th>Risk</th><th>Quantum</th><th>Recommendation</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">Run an ECDAT file or workspace scan to populate this report.</div>'}
  </body></html>`
}

async function exportCbom(): Promise<void> {
  const findings = allFindings()
  if (!findings.length) {
    void vscode.window.showInformationMessage('ECDAT: Run a scan before exporting a CBOM.')
    return
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'ecdat-cbom.json')
      : undefined,
    filters: { JSON: ['json'] },
    saveLabel: 'Export ECDAT CBOM',
  })
  if (!target) return
  const riskDistribution = findings.reduce<Record<string, number>>((counts, item) => {
    counts[item.risk] = (counts[item.risk] || 0) + 1
    return counts
  }, {})
  const report = {
    specification: 'ECDAT CBOM Prototype 1.0',
    generated_at: new Date().toISOString(),
    workspace: vscode.workspace.name || 'workspace',
    input_type: lastInputType,
    engines: lastEngines,
    files_with_findings: results.size,
    findings_count: findings.length,
    risk_distribution: riskDistribution,
    findings,
    disclaimer: 'Rule-based prototype inventory; validate findings before security decisions.',
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(report, null, 2), 'utf8'))
  void vscode.window.showInformationMessage('ECDAT: CBOM exported successfully.')
}

function riskRank(risk: string): number {
  return ({ critical: 0, high: 1, medium: 2, low: 3, info: 4 } as Record<string, number>)[risk] ?? 5
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character] || character))
}
