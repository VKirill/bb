// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { ServerAccessStatus } from "@bb/server-contract";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { MachinesSettingsSection } from "./MachinesSettingsSection";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    experimental_server: {
      checkMove: vi.fn(),
      moveStatus: vi.fn(),
      startMove: vi.fn(),
    },
    hosts: {
      delete: vi.fn(),
      experimental_create: vi.fn(),
      experimental_getEnrollmentCommand: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      experimental_listProviders: vi.fn(),
    },
    system: { config: vi.fn() },
    threads: {
      count: vi.fn(async () => ({ total: 0 })),
      list: vi.fn(async () => []),
    },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({
    localDaemonHostId: "host_primary",
    platform: "darwin",
  }),
}));

const READY_SERVER_ACCESS: ServerAccessStatus = {
  providers: [
    {
      id: "direct",
      displayName: "Manual",
      description: "Use your own domain or network address.",
      pluginId: null,
      availability: null,
    },
  ],
  defaultProviderId: "direct",
  effectiveUrl: "https://bb.example.com",
  urlSource: "setting",
};

const reserved = makeHost({
  id: "host-reserved",
  name: "Manual machine",
  status: "disconnected",
  machineProviderId: "manual",
  lifecycle: {
    phase: "creating",
    suspendedAt: null,
    message: "Waiting for the machine",
    pendingLog: "",
    teardown: null,
  },
});

beforeEach(() => {
  vi.stubGlobal("crypto", {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    randomUUID: undefined,
  });
  vi.mocked(sdk.system.config).mockResolvedValue(
    makeSystemConfig({
      serverAccess: READY_SERVER_ACCESS,
      primaryHostId: "host_primary",
    }),
  );
  vi.mocked(sdk.hosts.list).mockResolvedValue([
    makeHost({ id: "host_primary", name: "MacBook Pro" }),
  ]);
  vi.mocked(sdk.hosts.experimental_listProviders).mockResolvedValue([]);
  vi.mocked(sdk.experimental_server.moveStatus).mockResolvedValue({
    move: null,
    lastMove: null,
  });
  vi.mocked(sdk.hosts.experimental_create).mockResolvedValue(reserved);
  vi.mocked(sdk.hosts.experimental_getEnrollmentCommand).mockResolvedValue({
    command: "bb machine enroll from-settings",
    windowsCommand: "irm windows | iex",
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(sdk.hosts.get).mockImplementation(() => new Promise(() => {}));
  vi.mocked(sdk.hosts.delete).mockResolvedValue({ ok: true });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("[sma:m_sw_add_machine_call] «Add a machine» on the machines page is what mints the join command: nothing is issued before the press, the command the server minted is shown after", async () => {
  const { wrapper } = createQueryClientTestHarness();
  const rendered = render(
    <MemoryRouter>
      <MachinesSettingsSection />
    </MemoryRouter>,
    { wrapper },
  );
  const add = await screen.findByRole("button", { name: "Add a machine" });
  expect(await screen.findByText("MacBook Pro")).toBeDefined();
  expect(sdk.hosts.experimental_create).not.toHaveBeenCalled();
  expect(sdk.hosts.experimental_getEnrollmentCommand).not.toHaveBeenCalled();

  fireEvent.click(add);

  expect(
    await screen.findByText("bb machine enroll from-settings"),
  ).toBeDefined();
  expect(sdk.hosts.experimental_create).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(sdk.hosts.experimental_create).mock.calls[0]![0],
  ).toMatchObject({ machineProviderId: "manual", wait: false });
  expect(
    vi.mocked(sdk.hosts.experimental_getEnrollmentCommand).mock.calls[0]![0]
      .hostId,
  ).toBe("host-reserved");
  rendered.unmount();
});
