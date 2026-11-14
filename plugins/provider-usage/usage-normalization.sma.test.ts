import { describe, expect, it } from "vitest";
import { selectUsageResources } from "./usage-normalization";

interface Row {
  name: string;
  providerId: string;
  accountKey: string | null;
  scope: "shared" | "host";
}

const identify = (row: Row) => ({
  providerId: row.providerId,
  accountKey: row.accountKey,
  scope: { kind: row.scope },
});

function pick(rows: Row[]): string[] {
  return selectUsageResources(rows, identify).map((row) => row.name);
}

describe("whose subscription is this (SMA proofs)", () => {
  it("[sma:k_lib_configdir] two readings of the same provider and account are one subscription shown once, the shared reading wins over a machine's; another account, another provider and a reading without an account key stay separate", () => {
    expect(
      pick([
        {
          name: "mac-a",
          providerId: "claude-code",
          accountKey: "acct-1",
          scope: "host",
        },
        {
          name: "mac-b",
          providerId: "claude-code",
          accountKey: "acct-1",
          scope: "host",
        },
      ]),
    ).toEqual(["mac-a"]);

    expect(
      pick([
        {
          name: "mac-a",
          providerId: "claude-code",
          accountKey: "acct-1",
          scope: "host",
        },
        {
          name: "pool",
          providerId: "claude-code",
          accountKey: "acct-1",
          scope: "shared",
        },
        {
          name: "mac-c",
          providerId: "claude-code",
          accountKey: "acct-1",
          scope: "host",
        },
      ]),
    ).toEqual(["pool"]);

    expect(
      pick([
        {
          name: "mine",
          providerId: "claude-code",
          accountKey: "acct-1",
          scope: "host",
        },
        {
          name: "other-account",
          providerId: "claude-code",
          accountKey: "acct-2",
          scope: "host",
        },
        {
          name: "other-provider",
          providerId: "codex",
          accountKey: "acct-1",
          scope: "host",
        },
        {
          name: "unknown-1",
          providerId: "claude-code",
          accountKey: null,
          scope: "host",
        },
        {
          name: "unknown-2",
          providerId: "claude-code",
          accountKey: null,
          scope: "host",
        },
      ]),
    ).toEqual([
      "mine",
      "other-account",
      "other-provider",
      "unknown-1",
      "unknown-2",
    ]);
  });
});
