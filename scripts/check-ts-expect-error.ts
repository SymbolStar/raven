#!/usr/bin/env bun
/**
 * Static guard: every `@ts-expect-error` must carry a description of
 * at least MIN_LENGTH characters (matching tseslint `ban-ts-comment`'s
 * `minimumDescriptionLength` default).
 *
 * tseslint's `ban-ts-comment` (strict tier) enforces this. biome 2.5's
 * `noTsIgnore` blocks `@ts-ignore` outright but doesn't require
 * descriptions on `@ts-expect-error`.
 *
 * Uses the TypeScript scanner so it handles line comments, block
 * comments, and multi-line block-comment descriptions uniformly.
 */

import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"

const ROOTS = [
  join(import.meta.dir, "..", "packages", "proxy", "src"),
  join(import.meta.dir, "..", "packages", "proxy", "test"),
  join(import.meta.dir, "..", "packages", "dashboard", "src"),
  join(import.meta.dir, "..", "packages", "dashboard", "test"),
]

const MIN_LENGTH = 10

interface Violation {
  path: string
  line: number
  reason: "missing" | "too_short"
  found: string
}

function scanFile(path: string, src: string): Violation[] {
  const violations: Violation[] = []
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, undefined, src)
  const lineStarts = ts.computeLineStarts(src)

  const posToLine = (pos: number) => {
    // Binary search for the last lineStart ≤ pos.
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid]! <= pos) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const text = scanner.getTokenText()
      const idx = text.indexOf("@ts-expect-error")
      if (idx !== -1) {
        // Everything after the directive is the description.
        let rest = text.slice(idx + "@ts-expect-error".length)
        // Strip trailing "*/" for block comments.
        if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
          rest = rest.replace(/\*\/\s*$/, "")
          // Strip leading whitespace/`*` on each subsequent line so a
          // multi-line block description reads as flat text.
          rest = rest.replace(/\n\s*\*?/g, " ")
        }
        // Strip common separators (`-`, `–`, `—`, `:`) once, then trim.
        rest = rest.replace(/^\s*[-–—:]?\s*/, "").trim()
        if (rest.length === 0) {
          violations.push({
            path,
            line: posToLine(scanner.getTokenPos()),
            reason: "missing",
            found: "",
          })
        } else if (rest.length < MIN_LENGTH) {
          violations.push({
            path,
            line: posToLine(scanner.getTokenPos()),
            reason: "too_short",
            found: rest,
          })
        }
      }
    }
    token = scanner.scan()
  }

  return violations
}

async function main(): Promise<void> {
  const violations: Violation[] = []
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
        const src = readFileSync(full, "utf-8")
        const repoRel = relative(join(import.meta.dir, ".."), full)
        for (const v of scanFile(repoRel, src)) violations.push(v)
      }
    }
  }

  for (const root of ROOTS) await walk(root)

  if (violations.length === 0) {
    console.log(`✓ every @ts-expect-error carries a ≥${MIN_LENGTH}-char explanation`)
    process.exit(0)
  }

  console.error(`✗ @ts-expect-error violations (${violations.length}, min ${MIN_LENGTH} chars):\n`)
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  [${v.reason}]`)
    if (v.reason === "too_short") console.error(`    found: "${v.found}" (${v.found.length} chars)`)
  }
  console.error(`\n  Add a short reason: \`// @ts-expect-error - <why, ≥${MIN_LENGTH} chars>\``)
  process.exit(1)
}

void main()
