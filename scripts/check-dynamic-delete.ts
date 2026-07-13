#!/usr/bin/env bun
/**
 * Static guard against dynamic `delete obj[computed]`.
 *
 * Rationale: `delete obj[key]` on a typed object hides property removal
 * from the type system and defeats optimizer inlining. Restrict to
 * genuine map-like deletes on `Record<string, unknown>` (or similar),
 * where the shape is a runtime-keyed dictionary.
 *
 * biome 2.5 ships `noDelete` (blanket ban on any `delete`) but no
 * per-shape `no-dynamic-delete`. tseslint's `no-dynamic-delete` sits
 * in strict tier; this script keeps parity — the strict rule blocks
 * `delete obj[computed]` but permits `delete obj.staticName`.
 *
 * Extend ALLOWED with justified sites (each entry requires a comment).
 */

import { readFileSync } from "node:fs"
import { join, relative } from "node:path"

const ROOTS = [
  join(import.meta.dir, "..", "packages", "proxy", "src"),
  join(import.meta.dir, "..", "packages", "proxy", "test"),
  join(import.meta.dir, "..", "packages", "dashboard", "src"),
  join(import.meta.dir, "..", "packages", "dashboard", "test"),
]

// Match `delete <ident>[<anything>]` — a computed member expression on
// the delete target. Static `delete obj.foo` and `delete obj["literal"]`
// (which TS still knows about at compile time) both pass. `delete obj[i]`,
// `delete map[key]` fail. Numeric-literal computed access is also caught
// (which is fine: `delete arr[3]` is a bad smell — leaves a hole).
const DYNAMIC_DELETE_RE = /\bdelete\s+[A-Za-z_$][\w$]*\s*\[[^\]]+\]/

// Whitelist: repo-relative path → reason. Empty for now.
const ALLOWED: Record<string, string> = {}

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
        if (repoRel in ALLOWED) continue
        const src = readFileSync(full, "utf-8")
        const lines = src.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          if (DYNAMIC_DELETE_RE.test(line)) {
            // Skip string-literal computed access — TS can track those.
            const withoutStrings = line
              .replace(/"[^"]*"/g, '""')
              .replace(/'[^']*'/g, "''")
              .replace(/`[^`]*`/g, "``")
            if (DYNAMIC_DELETE_RE.test(withoutStrings)) {
              violations.push({ path: repoRel, line: i + 1, text: line.trim() })
            }
          }
        }
      }
    }
  }

  for (const root of ROOTS) await walk(root)

  if (violations.length === 0) {
    console.log("✓ no dynamic delete found")
    process.exit(0)
  }

  console.error(`✗ dynamic delete forbidden (${violations.length} site${violations.length === 1 ? "" : "s"}):\n`)
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}`)
    console.error(`    ${v.text}`)
  }
  console.error("\n  Use a static property name, or refactor to a Map/Record helper.")
  process.exit(1)
}

main()
