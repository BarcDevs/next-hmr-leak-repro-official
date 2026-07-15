// Automated HMR trigger: toggles a comment in app/page.tsx N times so you
// don't have to save manually. Takes heap snapshots before and after via CDP.
//
// Usage:
//   node .heap-diagnostics/trigger.mjs [count] [port]
//   count  – number of recompiles (default 50)
//   port   – Node inspector port of the Next dev server child process (default 9230)
//
// Next.js spawns two inspector targets when started with --inspect=9229:
//   9229 – the launcher (next bin) — NOT the leaking process
//   9230 – start-server.js (the actual dev server) — THIS is where the leak lives
//
// Requires: npm run dev:leak (starts next dev with --inspect=9229)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TARGET = path.join(ROOT, 'app', 'page.tsx')
const SNAP_A = path.join(ROOT, 'heap-a.json')
const SNAP_B = path.join(ROOT, 'heap-b.json')

const count = parseInt(process.argv[2] ?? '50', 10)
const port = process.argv[3] ?? '9230'
const DELAY_MS = 900 // must exceed HMR compile time; ~800ms typical

// ---- CDP helpers ----

const listTargets = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!res.ok) throw new Error(`CDP /json/list returned ${res.status}. Is npm run dev:leak running?`)
    return res.json()
}

const connect = async () => {
    const targets = await listTargets()
    const target = targets.find(t => t.webSocketDebuggerUrl)
    if (!target) throw new Error('No debuggable target on port ' + port)
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(target.webSocketDebuggerUrl)
        ws.addEventListener('open', () => resolve(ws))
        ws.addEventListener('error', e => reject(new Error('WebSocket error: ' + (e.message ?? ''))))
    })
}

const rpc = (ws, id, method, params = {}) =>
    new Promise((resolve, reject) => {
        const handler = ev => {
            const msg = JSON.parse(ev.data)
            if (msg.id === id) {
                ws.removeEventListener('message', handler)
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
            }
        }
        ws.addEventListener('message', handler)
        ws.send(JSON.stringify({ id, method, params }))
    })

const heapMB = async ws => {
    await rpc(ws, 90, 'Runtime.enable')
    const r = await rpc(ws, 91, 'Runtime.evaluate', {
        expression: 'Math.round(process.memoryUsage().heapUsed/1048576)',
        returnByValue: true,
    })
    return r.result.value
}

const snapshot = async (ws, outfile, idBase) => {
    const out = fs.createWriteStream(outfile)
    let bytes = 0
    const onMsg = ev => {
        const msg = JSON.parse(ev.data)
        if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
            out.write(msg.params.chunk)
            bytes += msg.params.chunk.length
        }
    }
    ws.addEventListener('message', onMsg)
    await rpc(ws, idBase, 'HeapProfiler.enable')
    await rpc(ws, idBase + 1, 'HeapProfiler.collectGarbage')
    await rpc(ws, idBase + 2, 'HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false })
    ws.removeEventListener('message', onMsg)
    await new Promise(r => out.end(r))
    console.log(`  wrote ${outfile} (${(bytes / 1e6).toFixed(1)} MB)`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- HMR trigger ----

const toggleComment = (() => {
    const MARKER = '// hmr-trigger'
    let state = false
    return () => {
        let src = fs.readFileSync(TARGET, 'utf8')
        if (state) {
            src = src.replace('\n' + MARKER, '')
        } else {
            src = src.replace("'use client'", "'use client'\n" + MARKER)
        }
        state = !state
        fs.writeFileSync(TARGET, src, 'utf8')
    }
})()

// ---- main ----

const main = async () => {
    console.log(`\nConnecting to Node inspector on port ${port}...`)
    let ws
    try {
        ws = await connect()
    } catch (e) {
        console.error(`\nFailed: ${e.message}`)
        console.error('Make sure you started the server with: npm run dev:leak')
        process.exit(1)
    }
    console.log('Connected.\n')

    console.log('Taking baseline heap snapshot (heap-a.json)...')
    await snapshot(ws, SNAP_A, 10)
    const mbBefore = await heapMB(ws)
    console.log(`Heap before: ${mbBefore} MB\n`)

    console.log(`Triggering ${count} HMR recompiles (${DELAY_MS}ms gap each)...`)
    for (let i = 1; i <= count; i++) {
        toggleComment()
        process.stdout.write(`\r  recompile ${i}/${count}`)
        await sleep(DELAY_MS)
    }
    console.log('\nDone. Waiting 2s for final compile...')
    await sleep(2000)

    const mbAfter = await heapMB(ws)
    console.log(`Heap after:  ${mbAfter} MB  (+${mbAfter - mbBefore} MB over ${count} recompiles)`)

    console.log('\nTaking post-recompile heap snapshot (heap-b.json)...')
    await snapshot(ws, SNAP_B, 20)

    ws.close()

    console.log('\nRun the diff:')
    console.log('  node .heap-diagnostics/diff.mjs heap-a.json heap-b.json\n')
}

main().catch(e => { console.error('ERR', e.message); process.exit(1) })
