import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_hostToolchain as hostToolchain } from "@get-bb/plugin-sdk/process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClaudeCodeExecutable } from "./session-options.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fakeProgram(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-claude-bin-"));
  dirs.push(dir);
  const file = join(dir, "claude-real");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, mode);
  return file;
}

function withPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

describe("how the Claude CLI is started on this machine (SMA proofs)", () => {
  it("[sma:m_ln_resolve_bin] an explicit CLI path is used when it is executable and refused when it is not; on Windows the real claude.exe is looked up, never a shim, elsewhere plain claude", () => {
    const good = fakeProgram(0o755);
    expect(
      resolveClaudeCodeExecutable({
        env: { BB_CLAUDE_CODE_EXECUTABLE: ` ${good} ` },
      }),
    ).toBe(good);
    const bad = fakeProgram(0o644);
    expect(() =>
      resolveClaudeCodeExecutable({ env: { BB_CLAUDE_CODE_EXECUTABLE: bad } }),
    ).toThrow(`must point to an executable Claude CLI path: ${bad}`);

    const asked: string[] = [];
    vi.spyOn(hostToolchain, "resolve").mockImplementation((command) => {
      asked.push(command);
      return `/resolved/${command}`;
    });
    expect(resolveClaudeCodeExecutable({ env: {} })).toBe("/resolved/claude");
    withPlatform("win32");
    expect(resolveClaudeCodeExecutable({ env: {} })).toBe(
      "/resolved/claude.exe",
    );
    expect(asked).toEqual(["claude", "claude.exe"]);
  });
});
