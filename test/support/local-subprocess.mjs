/**
 * 测试用的本地 subprocess 替身：实现宿主 `subprocess.spawn` 的 handle 契约
 * （collected.stdout/stderr.readFrom(offset)、done、terminate），让自测在
 * 没有宿主服务时也能走真实执行路径。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

class Collector {
    constructor(maxBytes, spillCap) {
        this.maxBytes = maxBytes
        this.spillCap = spillCap
        this.text = ''
        this.lossy = false
        this.spillPath = null
        this.spilled = 0
        this.fd = null
        this.opened = false
    }
    openSpill() {
        if (this.opened) return
        this.opened = true
        this.spillPath = join(tmpdir(), `local-spill-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`)
        this.fd = openSync(this.spillPath, 'w')
    }
    writeSpill(text) {
        if (this.fd === null) this.openSpill()
        const room = this.spillCap - this.spilled
        if (room <= 0) return
        const buf = Buffer.from(text, 'utf8').subarray(0, room)
        writeSync(this.fd, buf)
        this.spilled += buf.length
    }
    add(text) {
        this.text += text
        if (Buffer.byteLength(this.text, 'utf8') <= this.maxBytes) return
        this.lossy = true
        if (this.fd === null) { this.openSpill(); this.writeSpill(this.text) }
        else this.writeSpill(text)
    }
    close() { if (this.fd !== null) { try { closeSync(this.fd) } catch { /* 已关 */ } this.fd = null } }
    readFrom(offset) {
        return {
            text: this.text.slice(offset),
            nextOffset: this.text.length,
            lossy: this.lossy,
            ...(this.spillPath === null ? {} : { spillPath: this.spillPath }),
        }
    }
}

export function createLocalSubprocess() {
    return {
        spawn(spec) {
            const stdout = new Collector(spec.stdio?.stdout?.maxBytes ?? 1024 * 1024, spec.stdio?.stdout?.spill?.maxBytes ?? 64 * 1024 * 1024)
            const stderr = new Collector(spec.stdio?.stderr?.maxBytes ?? 1024 * 1024, spec.stdio?.stderr?.spill?.maxBytes ?? 64 * 1024 * 1024)
            // 记录 MSYS 进程组号（宿主在 Windows 上也是靠 PGID + taskkill 做树的终止）。
            const pgidFile = join(tmpdir(), `local-pgid-${process.pid}-${Math.random().toString(36).slice(2, 8)}.txt`)
            const isCommand = spec.argv[1] === '-c'
            const script = isCommand
                ? 'printf %s $$ >| "$1"; shift; eval "$1"'
                : 'printf %s $$ >| "$1"; shift; exec bash "$1"'
            const payload = isCommand ? spec.argv[2] : spec.argv[1]
            const wrapped = [spec.argv[0], '-c', script, 'bash', pgidFile, payload]
            const child = spawn(wrapped[0], wrapped.slice(1), {
                cwd: spec.cwd,
                env: spec.env,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
            })
            child.stdout.setEncoding('utf8')
            child.stderr.setEncoding('utf8')
            child.stdout.on('data', (chunk) => stdout.add(chunk))
            child.stderr.on('data', (chunk) => stderr.add(chunk))
            const terminate = () => {
                try {
                    const pgid = readFileSync(pgidFile, 'utf8').trim()
                    if (pgid !== '') spawnSync(spec.argv[0], ['-c', `kill -KILL -${pgid} 2>/dev/null`], { windowsHide: true, stdio: 'ignore' })
                }
                catch { /* 组号还没写出来 */ }
                if (process.platform === 'win32') {
                    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 已退出 */ }
                }
                else {
                    try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ }
                }
                try { child.kill() } catch { /* 已退出 */ }
            }
            const done = new Promise((resolve) => {
                let settled = false
                const settle = (exitCode, signal) => {
                    if (settled) return
                    settled = true
                    stdout.close()
                    stderr.close()
                    resolve({ exitCode: exitCode ?? null, signal: signal ?? null })
                }
                child.on('exit', (code, signal) => setTimeout(() => {
                    try { rmSync(pgidFile, { force: true }) } catch { /* 已清理 */ }
                    settle(code, signal)
                }, 20))
                child.on('error', () => settle(null, null))
            })
            let onAbort
            if (spec.signal !== undefined && spec.signal !== null) {
                onAbort = () => terminate()
                if (spec.signal.aborted) terminate()
                else spec.signal.addEventListener('abort', onAbort, { once: true })
            }
            return { collected: { stdout, stderr }, done: done.finally(() => { if (onAbort !== undefined) spec.signal.removeEventListener('abort', onAbort) }), terminate }
        },
    }
}
