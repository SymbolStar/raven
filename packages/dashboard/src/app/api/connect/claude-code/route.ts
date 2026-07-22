import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Settings = Record<string, unknown> & { env?: Record<string, string> };

function ravenConfigDir(): string {
  if (process.env.RAVEN_CONFIG_DIR) return process.env.RAVEN_CONFIG_DIR;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "raven");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "raven");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "raven");
}

async function ravenApiKey(): Promise<string | null> {
  if (process.env.RAVEN_API_KEY) return process.env.RAVEN_API_KEY;

  try {
    const gatewayPath = path.join(ravenConfigDir(), "gateway.json");
    const gateway = JSON.parse(await readFile(gatewayPath, "utf8")) as { apiKey?: unknown };
    return typeof gateway.apiKey === "string" && gateway.apiKey ? gateway.apiKey : null;
  } catch {
    return null;
  }
}

function configFor(baseUrl: string, apiKey: string): Settings {
  return {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic.claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic.claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic.claude-haiku-4-5",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    },
  };
}

function isLocalDashboardRequest(request: Request): boolean {
  const host = request.headers.get("host")?.split(":")[0];
  const origin = request.headers.get("origin");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]") return false;
  if (!origin) return true;

  try {
    const originHost = new URL(origin).hostname;
    return originHost === "localhost" || originHost === "127.0.0.1" || originHost === "[::1]";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isLocalDashboardRequest(request)) {
    return NextResponse.json(
      { error: "Claude Code can only be configured from a local Dashboard. Copy the configuration when using a remote Dashboard." },
      { status: 403 },
    );
  }

  let body: { baseUrl?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.baseUrl !== "string" || !URL.canParse(body.baseUrl)) {
    return NextResponse.json({ error: "A valid Raven base URL is required" }, { status: 400 });
  }

  const apiKey = await ravenApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Raven API key is unavailable. Start Raven with raven start or set RAVEN_API_KEY." },
      { status: 503 },
    );
  }

  const claudeDir = path.join(os.homedir(), ".claude");
  const settingsPath = path.join(claudeDir, "settings.json");
  let settings: Settings = {};
  let backupPath: string | null = null;

  try {
    await access(settingsPath);
    backupPath = path.join(claudeDir, `settings.raven-backup-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    await copyFile(settingsPath, backupPath);
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    settings = parsed as Settings;
  } catch {
    if (backupPath) {
      return NextResponse.json({ error: "Existing Claude Code settings.json is not valid JSON" }, { status: 400 });
    }
  }

  const ravenConfig = configFor(body.baseUrl.replace(/\/+$/, ""), apiKey);
  const updated: Settings = {
    ...settings,
    env: { ...settings.env, ...ravenConfig.env },
  };

  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await writeFile(settingsPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });

  return NextResponse.json({
    settingsPath,
    backupPath,
    message: "Claude Code configuration saved. Restart Claude Code to apply it.",
  });
}
