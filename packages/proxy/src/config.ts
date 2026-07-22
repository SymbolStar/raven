import { getDefaultTokenPath, getDefaultDbPath } from "./lib/app-dirs";

export interface Config {
  port: number;
  apiKey: string;
  internalKey: string;
  tokenPath: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  baseUrl: string;
  disableCopilot: boolean;
}

export function loadConfig(): Config {
  const port = parseInt(process.env.RAVEN_PORT ?? "7024", 10);
  const apiKey = process.env.RAVEN_API_KEY ?? "";
  const internalKey = process.env.RAVEN_INTERNAL_KEY ?? "";
  const tokenPath = getDefaultTokenPath();
  const dbPath = getDefaultDbPath();
  const logLevel = (process.env.RAVEN_LOG_LEVEL ?? "info") as Config["logLevel"];
  const baseUrl = process.env.RAVEN_BASE_URL ?? "";
  // Custom upstreams are the default. Set RAVEN_DISABLE_COPILOT=false to opt
  // into GitHub Copilot initialization and its associated OAuth flow.
  const disableCopilot = process.env.RAVEN_DISABLE_COPILOT !== "false";

  return { port, apiKey, internalKey, tokenPath, dbPath, logLevel, baseUrl, disableCopilot };
}
