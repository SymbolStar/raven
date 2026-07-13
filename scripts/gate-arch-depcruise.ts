#!/usr/bin/env bun
/**
 * Architecture gate — depcruise runner with an empty-cruise guard.
 *
 * dependency-cruiser 18.x pins its typescript peer to `>=2 <7`. Our
 * workspace runs typescript 7 (see `build(typescript): finish TS 7
 * upgrade via @typescript/native-preview`). Without a TS-6 copy in
 * the tree depcruise silently drops every .ts file and reports
 * "0 modules, 0 dependencies cruised" — the arch rules never run
 * and violations slip through pre-push and CI.
 *
 * Workaround: root ships a `typescript6-for-depcruise` devDependency
 * (npm alias of typescript@6.0.3) so depcruise can resolve a
 * peer-compatible TS via bun's isolated store. Nothing else picks
 * that alias up — the rest of the toolchain runs on TS 7.
 *
 * This wrapper adds the second half of the fix: hard-fail if the
 * cruise reports zero modules or zero dependencies. That's the same
 * signal a broken parser produced last time and it must not read
 * as green again.
 *
 * When depcruise upstream supports TS 7, delete the alias (from
 * package.json) and simplify this script back to a plain invocation
 * — or fold it into gate:arch directly.
 */

import { spawnSync } from "node:child_process"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")

const proc = spawnSync(
  "bunx",
  ["depcruise", "--config", "dependency-cruiser.config.cjs", "packages/proxy/src"],
  { cwd: REPO_ROOT, stdio: ["inherit", "pipe", "inherit"] },
)

const output = proc.stdout?.toString() ?? ""
process.stdout.write(output)

if (proc.status !== 0) process.exit(proc.status ?? 1)

const match = output.match(/\((\d+) modules,\s*(\d+) dependencies cruised\)/)
if (!match) {
  console.error(
    "✗ depcruise output missing modules/dependencies summary — reporter format may have changed.",
  )
  process.exit(1)
}
const modules = Number.parseInt(match[1]!, 10)
const deps = Number.parseInt(match[2]!, 10)
if (modules === 0 || deps === 0) {
  console.error(
    `✗ depcruise cruised ${modules} modules / ${deps} dependencies.\n` +
      "  The TypeScript parser is disabled — arch rules did not run.\n" +
      "  Check that `typescript6-for-depcruise` is installed (see package.json)\n" +
      "  and that `bunx depcruise -i` reports a ✔ for typescript.",
  )
  process.exit(1)
}
