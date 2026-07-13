#!/usr/bin/env bun
/**
 * Static guard against dynamic `delete obj[computed]`.
 *
 * Rationale: `delete obj[key]` hides property removal from the type
 * system and defeats optimizer inlining. tseslint's `no-dynamic-delete`
 * (strict tier) blocks `delete obj[computed]` but permits
 * `delete obj.staticName` and `delete obj["static-literal"]`.
 *
 * Uses the TypeScript compiler API: earlier regex-based versions of
 * this check missed `delete value.nested[key]`, `delete x?.y[k]`,
 * multi-line delete expressions, and anything the tokenizer split
 * across the line. AST traversal makes the rule position-independent.
 *
 * biome 2.5 has no equivalent — `noDelete` is a blanket ban and
 * would fire on legitimate `Record<string, unknown>` deletes. This
 * script + that gap is the smallest wedge to reach strict parity.
 *
 * Extend ALLOWED with justified sites (each entry requires a comment).
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

// Whitelist: repo-relative path → reason. Empty for now.
const ALLOWED: Record<string, string> = {}

interface Violation {
  path: string
  line: number
  col: number
  snippet: string
}

/**
 * Walk into whichever member-expression sits at the tail end of
 * chained/parenthesised access. Returns true if the deepest access is
 * computed with a non-literal key — that's the shape tseslint bans.
 */
function isDynamicComputedTail(expr: ts.Expression): boolean {
  // Peel parens.
  let cur: ts.Node = expr
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression

  if (!ts.isElementAccessExpression(cur)) return false
  const arg = cur.argumentExpression
  // Static literals are fine — TS still tracks the property.
  if (ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return false
  }
  return true
}

/**
 * A DeleteExpression whose ultimate target is an ElementAccess with a
 * non-literal key. Nested paths like `delete a.b.c[k]` and
 * `delete a?.b[k]` all funnel through here.
 */
function collectFromNode(
  node: ts.Node,
  file: ts.SourceFile,
  path: string,
  out: Violation[],
): void {
  if (ts.isDeleteExpression(node)) {
    if (isDynamicComputedTail(node.expression)) {
      const start = file.getLineAndCharacterOfPosition(node.getStart(file))
      out.push({
        path,
        line: start.line + 1,
        col: start.character + 1,
        snippet: node.getText(file).split("\n")[0]!.trim(),
      })
    }
  }
  ts.forEachChild(node, (child) => collectFromNode(child, file, path, out))
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
        const repoRel = relative(join(import.meta.dir, ".."), full)
        if (repoRel in ALLOWED) continue
        const src = readFileSync(full, "utf-8")
        const scriptKind = name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        const file = ts.createSourceFile(full, src, ts.ScriptTarget.Latest, false, scriptKind)
        collectFromNode(file, file, repoRel, violations)
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
    console.error(`  ${v.path}:${v.line}:${v.col}`)
    console.error(`    ${v.snippet}`)
  }
  console.error("\n  Use a static property name, or refactor to a Map/Record helper.")
  process.exit(1)
}

void main()
