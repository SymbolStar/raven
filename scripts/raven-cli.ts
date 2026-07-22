#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

type GatewayConfig = {
  apiKey: string
  internalKey: string
}

const ROOT = path.resolve(import.meta.dir, "..")
const PROXY_PORT = process.env.RAVEN_PORT ?? "7025"
const DASHBOARD_PORT = process.env.RAVEN_DASHBOARD_PORT ?? "7023"
const CONFIG_DIR = process.env.RAVEN_CONFIG_DIR ?? defaultConfigDir()
const GATEWAY_CONFIG_PATH = path.join(CONFIG_DIR, "gateway.json")

function defaultConfigDir(): string {
  const home = process.env.HOME ?? "~"
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "raven")
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "raven")
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "raven")
}

function createKey(): string {
  return `rk-local-${randomBytes(32).toString("hex")}`
}

async function loadGatewayConfig(): Promise<{ config: GatewayConfig; created: boolean }> {
  const apiKeyOverride = process.env.RAVEN_API_KEY
  const internalKeyOverride = process.env.RAVEN_INTERNAL_KEY
  if (apiKeyOverride || internalKeyOverride) {
    if (!apiKeyOverride || !internalKeyOverride) {
      throw new Error("Set both RAVEN_API_KEY and RAVEN_INTERNAL_KEY, or neither.")
    }
    return {
      config: { apiKey: apiKeyOverride, internalKey: internalKeyOverride },
      created: false,
    }
  }

  try {
    const config = JSON.parse(await readFile(GATEWAY_CONFIG_PATH, "utf8")) as Partial<GatewayConfig>
    if (typeof config.apiKey === "string" && typeof config.internalKey === "string" && config.apiKey && config.internalKey) {
      return { config: { apiKey: config.apiKey, internalKey: config.internalKey }, created: false }
    }
  } catch {
    // Generate a new config when no valid local gateway config exists.
  }

  const config = { apiKey: createKey(), internalKey: createKey() }
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await writeFile(GATEWAY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  return { config, created: true }
}

function usage(): void {
  console.log(`Usage: raven start [--dev]

Commands:
  start       Start the Raven proxy and Dashboard.

Options:
  --dev       Use the Dashboard development server instead of the production server.

Environment:
  RAVEN_PORT              Proxy port (default: 7025)
  RAVEN_DASHBOARD_PORT    Dashboard port (default: 7023)
  RAVEN_CONFIG_DIR        Directory for the generated local keys
  RAVEN_API_KEY           Existing client key to use instead of the saved key
  RAVEN_INTERNAL_KEY      Existing Dashboard key to use instead of the saved key
`)
}

function stopProcess(process: ReturnType<typeof Bun.spawn> | null): void {
  if (!process) return
  try {
    process.kill("SIGTERM")
  } catch {
    // The child already stopped.
  }
}

async function start(dev: boolean): Promise<number> {
  const { config, created } = await loadGatewayConfig()
  const dashboardUrl = `http://localhost:${DASHBOARD_PORT}`
  const sharedEnv = {
    ...process.env,
    RAVEN_PORT: PROXY_PORT,
    RAVEN_API_KEY: config.apiKey,
    RAVEN_INTERNAL_KEY: config.internalKey,
    RAVEN_PROXY_URL: `http://localhost:${PROXY_PORT}`,
  }

  console.log("Starting Raven local gateway...")
  if (created) console.log(`Generated local keys in ${GATEWAY_CONFIG_PATH}`)
  console.log(`Dashboard: ${dashboardUrl}`)
  console.log(`Proxy:     http://localhost:${PROXY_PORT}`)
  console.log("Press Ctrl+C to stop both services.\n")

  const proxy = Bun.spawn(["bun", "run", "--filter", "@raven/proxy", "start"], {
    cwd: ROOT,
    env: sharedEnv,
    stdout: "inherit",
    stderr: "inherit",
  })
  const dashboard = Bun.spawn(
    dev
      ? ["bunx", "--bun", "next", "dev", "-p", DASHBOARD_PORT]
      : ["bun", "run", "--filter", "dashboard", "start"],
    {
      cwd: dev ? path.join(ROOT, "packages", "dashboard") : ROOT,
      env: sharedEnv,
      stdout: "inherit",
      stderr: "inherit",
    },
  )

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    console.log("\nStopping Raven services...")
    stopProcess(dashboard)
    stopProcess(proxy)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // If either service fails, stop its sibling instead of leaving it orphaned.
  const exitCode = await Promise.race([proxy.exited, dashboard.exited])
  shutdown()
  await Promise.all([proxy.exited, dashboard.exited])
  return exitCode === 0 ? 0 : 1
}

const [command, ...args] = process.argv.slice(2)
if (command !== "start" || args.some((arg) => arg !== "--dev")) {
  usage()
  process.exit(command ? 1 : 0)
}

start(args.includes("--dev"))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
