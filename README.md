# Next.js 16 Dev-Server HMR Module-Instance Retention Leak

**Minimal reproduction of vercel/next.js#94682**: Next.js 16 dev-server crashes mid-session with `JavaScript heap out of memory` even with `--max-old-space-size=8192`.

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

**Deliberate omission of fix**: This repo intentionally **does NOT** apply `experimental.optimizePackageImports: ['radix-ui']` in `next.config.ts`, so you can observe the leak in its full magnitude. (The fix reduces leak rate by ~18x for common edit paths.)

## Quick Start

```bash
npm install
npm run dev
```

Visit http://localhost:3000. Interact with the dialog and dropdown menu to ensure they load.

## Measuring the Leak

### 1. Take baseline heap snapshot

In a separate terminal (while `next dev` is running on port 3000):

```bash
node --inspect .heap-diagnostics/cdp.mjs snap 9229 heap-a.json
```

(The dev server inspector port defaults to 9229. Adjust if needed.)

### 2. Trigger HMR recompiles

Edit `app/page.tsx` — add a comment, tweak whitespace, or change the page text — then **save repeatedly** (~50–100 times). Each save triggers HMR and recompiles the app.

### 3. Take a second snapshot

```bash
node .heap-diagnostics/cdp.mjs snap 9229 heap-b.json
```

### 4. Diff constructor histograms

```bash
node .heap-diagnostics/diff.mjs heap-a.json heap-b.json
```

### Expected Output

```
===== TOP GROWTH BY COUNT (B - A) =====
    57320   57.3MB now=59800   string (module.hot.*)
     1280   75.7MB now=...     Object
      462   57.3MB now=...     synthetic (module wrappers)
   ...
```

The smoking gun: **`module.hot` HMR API method-name strings growing by ~1,146 per recompile**, indicating the prior module graph is retained.

## Fix (Not Applied Here)

To mitigate, add to `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  experimental: {
    optimizePackageImports: ['radix-ui']
  }
}
```

This tells Next.js to tree-shake the radix-ui barrel on build, reducing modules-per-recompile for UI components. The leak itself (upstream dev-server issue) remains, but the leak rate decreases proportionally.

## Files

- **`app/page.tsx`** — demo page with Dialog and DropdownMenu UI components
- **`components/ui/dialog.tsx`** — radix-ui Dialog primitive wrapper (umbrella barrel import)
- **`components/ui/dropdown-menu.tsx`** — radix-ui DropdownMenu primitive wrapper (umbrella barrel import)
- **`lib/utils.ts`** — `cn()` utility for Tailwind class merging
- **`.heap-diagnostics/cdp.mjs`** — CDP client for heap snapshots (Node 24 WebSocket)
- **`.heap-diagnostics/diff.mjs`** — Byte-scan heapsnapshot diff tool (handles files > 536MB without stringify)

## Environment

- **Next.js**: 16.2.9
- **React**: 19.2.7
- **Node**: 24+ (for global WebSocket and fetch)
- **OS**: Windows, macOS, or Linux

## References

- [vercel/next.js#94682](https://github.com/vercel/next.js/issues/94682) — Original issue
- Reproduction methodology: CDP inspector + byte-scan heapsnapshot diff (no full stringify → avoids V8 536MB string-length limit)
