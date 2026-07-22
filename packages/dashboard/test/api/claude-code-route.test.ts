import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = {
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
};

vi.mock("node:fs/promises", () => fs);
vi.mock("node:os", () => ({ default: { homedir: () => "/test-home" } }));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-backup-id" }));

function request(body: unknown, host = "localhost:7023") {
  return new Request("http://localhost:7023/api/connect/claude-code", {
    method: "POST",
    headers: { "content-type": "application/json", host },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:7023/api/connect/claude-code", {
    method: "POST",
    headers: { host: "localhost:7023", ...headers },
    body,
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("RAVEN_API_KEY", "raven-test-key");
  fs.access.mockResolvedValue(undefined);
  fs.copyFile.mockResolvedValue(undefined);
  fs.mkdir.mockResolvedValue(undefined);
  fs.readFile.mockResolvedValue('{"theme":"dark","env":{"KEEP_ME":"yes"}}');
  fs.writeFile.mockResolvedValue(undefined);
});

describe("POST /api/connect/claude-code", () => {
  it("rejects a remote Dashboard request", async () => {
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(request({ baseUrl: "http://localhost:7025" }, "192.168.1.5:7023"));

    expect(response.status).toBe(403);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an invalid base URL", async () => {
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(request({ baseUrl: "not a URL" }));

    expect(response.status).toBe(400);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a non-local origin", async () => {
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(rawRequest('{"baseUrl":"http://localhost:7025"}', { origin: "https://example.com" }));

    expect(response.status).toBe(403);
  });

  it("rejects an invalid JSON body", async () => {
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(rawRequest("not json"));

    expect(response.status).toBe(400);
  });

  it("returns unavailable when no Raven key can be loaded", async () => {
    vi.stubEnv("RAVEN_API_KEY", "");
    fs.readFile.mockRejectedValueOnce(new Error("no gateway config"));
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(request({ baseUrl: "http://localhost:7025" }));

    expect(response.status).toBe(503);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it("backs up and merges existing Claude Code settings", async () => {
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(request({ baseUrl: "http://localhost:7025/" }));

    expect(response.status).toBe(200);
    expect(fs.copyFile).toHaveBeenCalledTimes(1);
    expect(fs.writeFile).toHaveBeenCalledTimes(1);

    const [, contents] = fs.writeFile.mock.calls[0] as [string, string];
    const saved = JSON.parse(contents) as { theme: string; env: Record<string, string> };
    expect(saved.theme).toBe("dark");
    expect(saved.env.KEEP_ME).toBe("yes");
    expect(saved.env.ANTHROPIC_BASE_URL).toBe("http://localhost:7025");
    expect(saved.env.ANTHROPIC_AUTH_TOKEN).toBe("raven-test-key");
    expect(saved.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("anthropic.claude-opus-4-6");
  });

  it("creates settings when none exist", async () => {
    fs.access.mockRejectedValueOnce(new Error("missing"));
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(request({ baseUrl: "http://localhost:7025" }));

    expect(response.status).toBe(200);
    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.mkdir).toHaveBeenCalledWith("/test-home/.claude", { recursive: true, mode: 0o700 });
  });

  it("does not overwrite invalid existing settings", async () => {
    fs.readFile.mockResolvedValueOnce("not json");
    const { POST } = await import("@/app/api/connect/claude-code/route");
    const response = await POST(request({ baseUrl: "http://localhost:7025" }));

    expect(response.status).toBe(400);
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});
