'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export default function Home() {
  const [count, setCount] = useState(0)

  return (
    <div className={'min-h-screen bg-white p-8'}>
      <h1 className={'text-4xl font-bold mb-8'}>HMR Leak Reproduction</h1>

      <div className={'space-y-6'}>
        <div>
          <p className={'text-gray-600 mb-4'}>
            This minimal reproduction demonstrates the Next.js 16 dev-server HMR module-instance
            retention leak. Edit the code below and save repeatedly to observe heap growth via the
            CDP tools.
          </p>
        </div>

        <div className={'flex gap-4'}>
          <Dialog>
            <DialogTrigger className={'px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600'}>
              Open Dialog
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Dialog Title</DialogTitle>
                <DialogDescription>
                  This dialog uses radix-ui primitives imported via barrel syntax (import ... from
                  &apos;radix-ui&apos;), which amplifies the HMR leak.
                </DialogDescription>
              </DialogHeader>
              <p className={'mt-4 text-gray-600'}>Edit this file and save to trigger recompiles.</p>
            </DialogContent>
          </Dialog>

          <DropdownMenu>
            <DropdownMenuTrigger className={'px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300'}>
              Menu
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setCount(c => c + 1)}>
                Increment ({count})
              </DropdownMenuItem>
              <DropdownMenuItem>Edit</DropdownMenuItem>
              <DropdownMenuItem>Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className={'border-t pt-6'}>
          <h2 className={'text-xl font-semibold mb-3'}>To reproduce:</h2>
          <ol className={'list-decimal list-inside space-y-2 text-gray-700'}>
            <li>Run: npm install && npm run dev:leak</li>
            <li>Visit http://localhost:3000 and interact with the dialog/menu</li>
            <li>
              In another terminal, run: node .heap-diagnostics/trigger.mjs 50 9230 (automates
              snapshots + recompiles; port 9230 is the dev-server child, not 9229)
            </li>
            <li>Diff the snapshots: node .heap-diagnostics/diff.mjs heap-a.json heap-b.json</li>
            <li>
              Observe ~1,146 module.hot.* HMR method-name strings leaked per recompile, totaling
              ~50-60MB growth
            </li>
          </ol>
        </div>
      </div>
    </div>
  )
}
