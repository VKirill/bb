import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VK_OWNER_PAIRING_MAX_ATTEMPTS,
  consumeVkOwnerPairingCode,
  createVkOwnerPairingCode,
} from "../src/vk-owner-auth.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("failed pairing attempts (SMA proofs)", () => {
  it("[sma:m_gt_limiter] four wrong pairing codes are answered invalid, the fifth locks and burns the code so even the right code is then refused", () => {
    expect(VK_OWNER_PAIRING_MAX_ATTEMPTS).toBe(5);
    const dataDir = mkdtempSync(join(tmpdir(), "bb-pairing-"));
    dirs.push(dataDir);
    const now = Date.parse("2026-11-14T12:00:00.000Z");
    const { code } = createVkOwnerPairingCode(dataDir, now);

    const answers = [1, 2, 3, 4, 5].map(() =>
      consumeVkOwnerPairingCode(dataDir, "AAAAA-AAAAA", now + 1_000),
    );
    expect(answers).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "locked",
    ]);
    expect(consumeVkOwnerPairingCode(dataDir, code, now + 2_000)).toBe("none");
  });

  it("[sma:m_gt_limiter] the right code within the limit is accepted once", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "bb-pairing-"));
    dirs.push(dataDir);
    const now = Date.parse("2026-11-14T12:00:00.000Z");
    const { code } = createVkOwnerPairingCode(dataDir, now);
    for (let i = 0; i < VK_OWNER_PAIRING_MAX_ATTEMPTS - 1; i += 1) {
      expect(consumeVkOwnerPairingCode(dataDir, "BBBBB-BBBBB", now)).toBe(
        "invalid",
      );
    }
    expect(consumeVkOwnerPairingCode(dataDir, code, now)).toBe("ok");
    expect(consumeVkOwnerPairingCode(dataDir, code, now)).toBe("none");
  });
});
