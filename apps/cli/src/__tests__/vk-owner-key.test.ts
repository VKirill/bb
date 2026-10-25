import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVkOwnerSignature,
  verifyVkOwnerRequestSignature,
  VK_OWNER_SIG_HEADER,
} from "@bb/config/vk-owner-auth";
import { describe, expect, it, vi } from "vitest";
import {
  createFileStore,
  createKeychainStore,
  createOwnerKey,
  isOwnerSignedRequest,
  loadOwnerKey,
  ownerKeyFilePath,
  ownerSignatureHeaders,
} from "../vk-owner-key.js";

// VK EXPERIMENTAL: the owner key stays out of env vars and agent sessions.
describe("VK owner key store", () => {
  it("file store: 0600 in a 0700 directory, and a loose file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "vk-owner-key-"));
    const path = ownerKeyFilePath(dir, undefined);
    expect(path).toBe(join(dir, ".config", "bb-owner", "owner.key"));
    const store = createFileStore(path);
    const key = createOwnerKey(store);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, ".config", "bb-owner")).mode & 0o777).toBe(0o700);
    expect(loadOwnerKey(store)?.keyId).toBe(key.keyId);
    chmodSync(path, 0o644);
    expect(loadOwnerKey(store)).toBeNull();
  });

  it("keychain store: the item trusts no application, so every read prompts", () => {
    const exec = vi.fn(() => "");
    const store = createKeychainStore(exec as never);
    store.write("secret");
    const [command, args] = exec.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("security");
    expect(args.slice(args.indexOf("-T"), args.indexOf("-T") + 2)).toEqual(["-T", ""]);
    expect(args).toContain("add-generic-password");
    store.read();
    expect((exec.mock.calls[1] as unknown as [string, string[]])[1]).toContain("find-generic-password");
  });
});

describe("VK owner request signing", () => {
  const url = new URL("http://hub/api/v1/plugins/install");
  const clean = {} as Record<string, string>;

  function storeWithKey() {
    const dir = mkdtempSync(join(tmpdir(), "vk-owner-sign-"));
    const store = createFileStore(join(dir, "owner.key"));
    return { store, key: createOwnerKey(store) };
  }

  it("signs a plugin install outside a session, verifiable with the public key", () => {
    const { store, key } = storeWithKey();
    const body = new TextEncoder().encode("{}");
    const signed = ownerSignatureHeaders({ method: "POST", url, body, env: clean, store })!;
    const parsed = parseVkOwnerSignature(signed[VK_OWNER_SIG_HEADER])!;
    expect(parsed.keyId).toBe(key.keyId);
    expect(
      verifyVkOwnerRequestSignature({
        publicKey: key.publicKey,
        parsed,
        method: "POST",
        target: "/api/v1/plugins/install",
        body,
      }),
    ).toBe(true);
  });

  it("never signs inside an agent session, for reads, or without a key", () => {
    const { store } = storeWithKey();
    const args = { method: "POST", url, body: undefined, store };
    expect(ownerSignatureHeaders({ ...args, env: { BB_THREAD_ID: "thr_a" } })).toBeNull();
    expect(ownerSignatureHeaders({ ...args, env: { BB_VK_THREAD_TOKEN: "vkt1.x.y" } })).toBeNull();
    expect(ownerSignatureHeaders({ ...args, method: "GET", env: clean })).toBeNull();
    const empty = createFileStore(join(mkdtempSync(join(tmpdir(), "vk-owner-none-")), "none.key"));
    expect(ownerSignatureHeaders({ ...args, env: clean, store: empty })).toBeNull();
  });

  it("signs only what the hub treats as owner-only", () => {
    const u = (path: string) => new URL(`http://hub${path}`);
    expect(isOwnerSignedRequest("POST", u("/api/v1/plugins/x/rpc/y"))).toBe(true);
    expect(isOwnerSignedRequest("POST", u("/api/v1/files/write"))).toBe(true);
    expect(isOwnerSignedRequest("POST", u("/api/v1/threads/t/interactions/p/respond"))).toBe(true);
    expect(isOwnerSignedRequest("POST", u("/api/v1/threads/t/messages"))).toBe(false);
    expect(isOwnerSignedRequest("GET", u("/api/v1/plugins"))).toBe(false);
  });
});
