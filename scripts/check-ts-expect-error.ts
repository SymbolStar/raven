#!/usr/bin/env bun
/**
 * Static guard: every `@ts-expect-error` must carry an explanation.
 *
 * tseslint's `ban-ts-comment` with `minimumDescriptionLength` (part of
 * strict tier) enforces this. biome 2.5's `noTsIgnore` blocks
 * `@ts-ignore` outright but doesn't require descriptions on
 * `@ts-expect-error`. This script fills the gap.
 *
 * Accepted forms (case-insensitive after the directive):
 *   // @ts-expect-error - reason  (any of: `-`, `–`, `:`, whitespace + words)
 *   /* @ts-expect-error reason * /
 *
 * Rejected: bare `// @ts-expect-error` with no trailing text.
 */

import { readFileSync } from "node:fs"
import { join, relative } from "node:path"

const ROOTS = [
  join(import.meta.dir, "..", "packages", "proxy", "src"),
  join(import.meta.dir, "..", "packages", "proxy", "test"),
  join(import.meta.dir, "..", "packages", "dashboard", "src"),
  join(import.meta.dir, "..", "packages", "dashboard", "test"),
]

// Match a `@ts-expect-error` directive followed by anything OTHER than
// end-of-line-or-comment-close. The trailing chunk must contain at
// least one non-whitespace character to count as a description.
const BAD_RE = /@ts-expect-error(?:\s*)(?:\*\/|\n|$)/

async function main() {
  const violations: { path: string; line: number; text: string }[] = []
  const { readdir, stat } = await import("node:fs/promises")

  async function walk(dir: string) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      const s = await stat(full)
      if (s.isDirectory()) {
        if (name === "node_modules" || name === "coverage" || name === ".next" || name === "__golden__") continue
        await walk(full)
      } else if (/\.(ts|tsx)$/.test(name)) {
        const repoRel = relative(join(import.meta.dir, ".."), full)
        const src = readFileSync(full, "utf-8")
        const lines = src.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (!line.includes("@ts-expect-error")) continue
          if (BAD_RE.test(line)) {
            violations.push({ path: repoRel, line: i + 1, text: line.trim() })
          }
        }
      }
    }
  }

  for (const root of ROOTS) await walk(root)

  if (violations.length === 0) {
    console.log("✓ every @ts-expect-error carries an explanation")
    process.exit(0)
  }

  console.error(`✗ @ts-expect-error without description (${violations.length}):\n`)
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}`)
    console.error(`    ${v.text}`)
  }
  console.error("\n  Add a short reason: `// @ts-expect-error - <why>`")
  process.exit(1)
}

main()
