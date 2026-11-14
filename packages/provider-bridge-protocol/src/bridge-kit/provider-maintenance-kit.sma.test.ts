import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecutablePath } from "./provider-maintenance-kit.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("finding the vendor program on this machine (SMA proofs)", () => {
  it.skipIf(process.platform === "win32")(
    "[sma:m_ln_bin_present] the provider program is found by resolving its name on the machine's PATH, and a name that is not there resolves to nothing",
    async () => {
      const dir = await realpath(
        await mkdtemp(path.join(tmpdir(), "bb-vendor-bin-")),
      );
      dirs.push(dir);
      const program = path.join(dir, "bb-sma-vendor-cli");
      await writeFile(program, "#!/bin/sh\nexit 0\n");
      await chmod(program, 0o755);
      vi.stubEnv("PATH", dir);

      expect(await resolveExecutablePath("bb-sma-vendor-cli")).toBe(program);
      expect(await resolveExecutablePath("bb-sma-vendor-missing")).toBeNull();
    },
  );
});
