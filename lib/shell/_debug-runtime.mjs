import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
try {
    const opsPkg = require.resolve('dsh-ops/package.json')
    console.log('ops pkg', opsPkg)
    const opsRoot = dirname(opsPkg)
    const bashIpc = await import(pathToFileURL(join(opsRoot, 'lib', 'bash-ipc.js')).href)
    console.log('confinedBash?', typeof bashIpc.confinedBash)
    let pinnedRoot
    try { pinnedRoot = dirname(require.resolve('@dsh-ops/bash-win32-x64/package.json')) }
    catch { pinnedRoot = join(opsRoot, '..', '@dsh-ops', 'bash-win32-x64') }
    console.log('pinned', pinnedRoot)
    const r = bashIpc.confinedBash(join(pinnedRoot, 'usr', 'bin', 'bash.exe'), { source: 'bundled' })
    console.log('ok', JSON.stringify({ file: r.file, env: r.env }))
}
catch (error) {
    console.error('ERR', error?.message ?? String(error))
}
