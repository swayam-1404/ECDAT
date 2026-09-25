import { copyFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(extensionRoot, '..')
const files = [
  'backend/__init__.py',
  'backend/app/__init__.py',
  'backend/app/detector.py',
  'backend/app/risk.py',
  'backend/app/recommendations.py',
  'backend/app/vscode_bridge.py',
  'backend/app/scanner.py',
  'backend/app/openssl_inspector.py',
  'backend/app/container_tools.py',
]

await rm(join(extensionRoot, 'engine'), { recursive: true, force: true })
await mkdir(join(extensionRoot, 'engine', 'backend', 'app'), { recursive: true })
for (const relative of files) {
  const source = join(repositoryRoot, relative)
  const destination = join(extensionRoot, 'engine', relative)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}
console.log('Bundled the local ECDAT Python engine.')
