# Next.js 16 Dev-Server HMR Module-Instance Retention Leak

**Minimal reproduction of vercel/next.js#94716**: Next.js 16 dev-server crashes mid-session with `JavaScript heap out of memory` even with `--max-old-space-size=8192`.

## Issue

Running `next dev` on a project with frequent HMR recompiles (file edits) causes unbounded heap growth:

- **Baseline**: ~105 MB heap
- **After 50 recompiles**: ~591 MB (post-GC)
- **Leak rate**: ~10 MB retained per recompile → ~800 recompiles to OOM on 8GB heap

This occurs on **both Turbopack and webpack** bundlers in Next.js 16.2.9, making it a dev-server HMR issue, not bundler-specific.

## Root Cause

Every HMR recompile re-instantiates the entire module graph (with HMR handler closures, feedback cells, and source text). **The prior generation is never released.** Heap diff analysis reveals:

- **Module.hot HMR API method-name strings** (status, dispose, invalidate, check, accept, decline, addStatusHandler, etc.): **+57,320 over 50 recompiles ≈ 1,146 per recompile** (= one per module in the graph)
- **Object instances, synthetic module wrappers, and closure contexts** add ~60MB across 50 recompiles

## Leak Amplifier: Radix-UI Barrel Imports

This repo imports radix-ui components via the **umbrella barrel** (`import { Dialog as DialogPrimitive } from 'radix-ui'`), which re-exports the entire Radix library. Because the default Next.js `optimizePackageImports` does **not** include `radix-ui`, every HMR recompile of any component using UI primitives drags the full Radix barrel through the module graph.

**Deliberate omission of fix**: This repo intentionally **does NOT** apply `experimental.optimizePackageImports: ['radix-ui']` in `next.config.ts`, so you can observe the leak in its full magnitude.

## Quick Start

```bash
npm install
npm run dev:leak
```

> **`dev:leak` vs `dev`**: `dev:leak` starts Next.js with `NODE_OPTIONS=--inspect=9229`, which enables the Node inspector on the dev-server child process. This is required for heap snapshots — plain `npm run dev` will not expose a CDP port.

Visit http://localhost:3000 (or 3001 if 3000 is taken). Interact with the dialog and dropdown to confirm the app loads.

## Measuring the Leak (Automated)

The `trigger.mjs` script handles everything: baseline snapshot → automated recompiles → post-recompile snapshot.

**Terminal 1** — start the server:
```bash
npm run dev:leak
```

**Terminal 2** — run the trigger (after the server prints "Ready"):
```bash
node .heap-diagnostics/trigger.mjs 50 9230
```

> **Port note**: Next.js spawns two inspector targets. `9229` is the launcher process; `9230` is `start-server.js` — the actual dev server where the leak occurs. Always target `9230`.

When done, diff the snapshots:
```bash
node .heap-diagnostics/diff.mjs heap-a.json heap-b.json
```

### Expected Output

```
===== TOP GROWTH BY COUNT (B - A) =====
    57320   57.3MB now=59800   string  status
    57320   57.3MB now=59800   string  dispose
    57320   57.3MB now=59800   string  invalidate
    57320   57.3MB now=59800   string  check
    57320   57.3MB now=59800   string  accept
    57320   57.3MB now=59800   string  decline
    57320   57.3MB now=59800   string  addStatusHandler
    57320   57.3MB now=59800   string  addDisposeHandler
    ...
```

The smoking gun: **`module.hot` HMR API method-name strings growing by ~1,146 per recompile**, indicating the prior module graph is never released.

## Measuring the Leak (Manual)

If you prefer manual control:

### 1. Start the server with inspector
```bash
npm run dev:leak
```

### 2. Take baseline snapshot (targets the dev server child process on port 9230)
```bash
node .heap-diagnostics/cdp.mjs snap 9230 heap-a.json
```

### 3. Trigger HMR recompiles

Edit `app/page.tsx` — add a comment, tweak whitespace — then save **~50 times**. Each save triggers an HMR recompile.

### 4. Take post-recompile snapshot
```bash
node .heap-diagnostics/cdp.mjs snap 9230 heap-b.json
```

### 5. Diff
```bash
node .heap-diagnostics/diff.mjs heap-a.json heap-b.json
```

## Fix (Not Applied Here)

To mitigate, add to `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['radix-ui']
  }
}
```

This reduces modules-per-recompile for UI components. The upstream leak remains, but the rate decreases proportionally.

## Files

- **`app/page.tsx`** — demo page with Dialog and DropdownMenu UI components
- **`components/ui/dialog.tsx`** — radix-ui Dialog primitive wrapper (umbrella barrel import)
- **`components/ui/dropdown-menu.tsx`** — radix-ui DropdownMenu primitive wrapper (umbrella barrel import)
- **`lib/utils.ts`** — `cn()` utility for Tailwind class merging
- **`.heap-diagnostics/cdp.mjs`** — CDP client for heap snapshots (Node 24 WebSocket/fetch, no deps)
- **`.heap-diagnostics/diff.mjs`** — Byte-scan heapsnapshot diff (handles >536MB without stringify)
- **`.heap-diagnostics/trigger.mjs`** — Automated recompile trigger + snapshot orchestration

## Environment

- **Next.js**: 16.2.9 (canary)
- **React**: 19.2.7
- **Node**: 24+ (required for global WebSocket and fetch in CDP tools)
- **OS**: Windows, macOS, or Linux

## References

- [vercel/next.js#94716](https://github.com/vercel/next.js/issues/94716) — This issue
- Reproduction methodology: CDP inspector + byte-scan heapsnapshot diff (no full stringify → avoids V8 536MB string-length limit)
