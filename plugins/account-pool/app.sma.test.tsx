// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "person@example.com",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_5x",
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: Date.now() - 5 * 60_000,
    lastUsedHostId: "host-one",
    lastUsedHostName: "bee",
    limitWindows: [
      {
        slot: "primary",
        windowMinutes: 300,
        utilization: 0.21,
        resetAt: null,
        status: null,
        observedAt: 1,
        source: "usage",
      },
      {
        slot: "secondary",
        windowMinutes: 10_080,
        utilization: 0.4,
        resetAt: null,
        status: null,
        observedAt: 1,
        source: "usage",
      },
    ],
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    extraUsage: null,
    usageRestriction: null,
    observedAt: 1,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

function status(accounts: AccountSummary[]): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool/http",
    enabledAccountCount: accounts.filter((item) => item.enabled).length,
    inFlight: 0,
    accepting: true,
    hosts: [
      { hostId: "host-one", hostName: "bee", mintedAt: 1, lastUsedAt: 2 },
    ],
    accounts,
    routing: { claude: true, codex: true },
    parent: null,
  };
}

function config(): AccountPoolConfig {
  return {
    anthropicUpstreamBaseUrl: "https://api.anthropic.com",
    codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    switchThreshold: 0.98,
    parentMode: "proxy",
  };
}

function render(
  accounts: AccountSummary[],
  extraRpc: Record<string, () => object | null> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => status(accounts),
        "config.get": () => config(),
        ...extraRpc,
      },
      openUrl: () => true,
    },
  );
}

const codex = account({
  id: "22222222-2222-4222-8222-222222222222",
  provider: "codex",
  label: "pro@example.com",
  email: "pro@example.com",
  subscriptionType: "Pro",
  codexAccountId: "chatgpt-account",
  limitWindows: [
    {
      slot: "primary",
      windowMinutes: 10_080,
      utilization: 0.61,
      resetAt: null,
      status: null,
      observedAt: 1,
      source: "usage",
    },
  ],
});

describe("accounts page (SMA proofs)", () => {
  it("[sma:m_sw_accounts] every subscription is listed under its own provider with its windows, and a provider with none says so", async () => {
    const slot = render([account(), codex]);
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("pro@example.com")).toBeTruthy();
    expect(slot.getByText("Max")).toBeTruthy();
    expect(slot.getByText("Pro")).toBeTruthy();
    expect(slot.getByText("21%")).toBeTruthy();
    expect(slot.getByText("40%")).toBeTruthy();
    expect(slot.getByText("61%")).toBeTruthy();
    const sectionOf = (text: string) =>
      slot.getByText(text).closest("section")?.querySelector("h2")?.textContent;
    expect(sectionOf("person@example.com")).toBe("Claude");
    expect(sectionOf("pro@example.com")).toBe("Codex");
    slot.unmount();

    const onlyCodex = render([codex]);
    expect(await onlyCodex.findByText("pro@example.com")).toBeTruthy();
    expect(onlyCodex.getByText("No accounts yet.")).toBeTruthy();
    expect(onlyCodex.queryByText("person@example.com")).toBeNull();
  });

  it("[sma:m_sw_account_row] a row shows the windows of its subscription with their figures and the state, and its details name the machine it was last used on", async () => {
    const slot = render([
      account({
        status: "exhausted",
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 300,
            utilization: 0.98,
            resetAt: null,
            status: null,
            observedAt: 1,
            source: "usage",
          },
          {
            slot: "secondary",
            windowMinutes: 10_080,
            utilization: 0.35,
            resetAt: null,
            status: null,
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
    ]);
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    const figureOf = (label: string) =>
      slot.getByText(label).nextElementSibling?.textContent;
    expect(figureOf("5H")).toBe("98%");
    expect(figureOf("7D")).toBe("35%");
    expect(figureOf("FABLE")).toBe("—");
    expect(slot.getByText(/^Exhausted/u)).toBeTruthy();
    expect(slot.getByText("used 5 min ago")).toBeTruthy();

    fireEvent.click(
      slot.getByRole("button", { name: "Open person@example.com details" }),
    );
    expect(await slot.findByText("Last used")).toBeTruthy();
    expect(slot.getByText("5 min ago · bee")).toBeTruthy();
  });

  it("[sma:m_sw_add_account] the Claude menu offers sign-in and an API key; Codex offers sign-in only; the API key goes through the add operation", async () => {
    const block = { selector: "span.block" };
    const codexMenu = render([]);
    const codexButtons = await codexMenu.findAllByRole("button", {
      name: "Add account",
    });
    expect(codexButtons).toHaveLength(2);
    fireEvent.pointerDown(codexButtons[1]!);
    expect(await codexMenu.findByText("Sign in to Codex", block)).toBeTruthy();
    expect(codexMenu.queryByText("Add API key…", block)).toBeNull();
    codexMenu.unmount();

    const slot = render([], { "account.add": () => ({}) });
    const addButtons = await slot.findAllByRole("button", {
      name: "Add account",
    });
    fireEvent.pointerDown(addButtons[0]!);
    expect(await slot.findByText("Sign in to Claude", block)).toBeTruthy();
    fireEvent.click(slot.getByText("Add API key…", block));
    const keyInput = await slot.findByLabelText("Anthropic API key");
    fireEvent.change(keyInput, { target: { value: "sk-sma-ui-key" } });
    fireEvent.click(slot.getByRole("button", { name: "Add API key" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.add",
        input: {
          provider: "claude",
          apiKey: "sk-sma-ui-key",
          label: null,
          priority: 100,
        },
      }),
    );
  });
});
