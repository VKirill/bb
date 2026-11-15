// @vitest-environment jsdom

import { makeHost } from "@bb/test-helpers/domain-fixtures";
import type { ServerAccessStatus } from "@bb/server-contract";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { Dialog, DialogContent } from "@bb/shared-ui/dialog";
import { AddMachineContent, ManualMachineSetup } from "./AddMachineDialog";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: {
      delete: vi.fn(),
      experimental_create: vi.fn(),
      experimental_getEnrollmentCommand: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
    },
    system: { config: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
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

const UNSET_SERVER_ACCESS: ServerAccessStatus = {
  ...READY_SERVER_ACCESS,
  effectiveUrl: null,
  urlSource: null,
};

beforeEach(() => {
  vi.stubGlobal("crypto", {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    randomUUID: undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const reservedHost = makeHost({
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

const POSIX_COMMAND = "bb machine enroll test";
const WINDOWS_COMMAND = "irm windows-command | iex";

function stubManualLaunch(configure?: () => void) {
  vi.mocked(sdk.hosts.experimental_create).mockResolvedValue(reservedHost);
  vi.mocked(sdk.hosts.experimental_getEnrollmentCommand).mockResolvedValue({
    command: POSIX_COMMAND,
    windowsCommand: WINDOWS_COMMAND,
    expiresAt: Date.now() + 60_000,
  });
  vi.mocked(sdk.hosts.get).mockImplementation(() => new Promise(() => {}));
  vi.mocked(sdk.hosts.delete).mockResolvedValue({ ok: true });
  configure?.();
}

function renderInDialog(content: ReactNode) {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <Dialog open modal={false}>
        <DialogContent>{content}</DialogContent>
      </Dialog>
    </MemoryRouter>,
    { wrapper },
  );
}

function setup(configure?: () => void) {
  stubManualLaunch(configure);
  return renderInDialog(
    <ManualMachineSetup serverMachineName={null} onOpenChange={() => {}} />,
  );
}

function renderAddMachineContent(
  primaryHostId: string | null,
  serverAccess: ServerAccessStatus = READY_SERVER_ACCESS,
) {
  stubManualLaunch(() => {
    vi.mocked(sdk.system.config).mockResolvedValue(
      makeSystemConfig({ serverAccess, primaryHostId }),
    );
    vi.mocked(sdk.hosts.list).mockResolvedValue([
      makeHost({ id: "host_laptop", name: "MacBook Pro" }),
      makeHost({ id: "host_server", name: "Mac mini" }),
    ]);
  });
  return renderInDialog(<AddMachineContent onOpenChange={() => {}} />);
}

it("[sma:d_machine_pair] opening the dialog reserves one manual host and shows the invitation command the server minted for it, per platform", async () => {
  const rendered = setup();
  expect(await screen.findByText(POSIX_COMMAND)).toBeDefined();

  expect(sdk.hosts.experimental_create).toHaveBeenCalledTimes(1);
  const request = vi.mocked(sdk.hosts.experimental_create).mock.calls[0]![0];
  expect(request).toMatchObject({
    machineProviderId: "manual",
    inputs: null,
    wait: false,
  });
  expect(request.key).toEqual(expect.any(String));
  expect(
    vi.mocked(sdk.hosts.experimental_getEnrollmentCommand).mock.calls[0]![0]
      .hostId,
  ).toBe("host-reserved");

  expect(screen.queryByText(WINDOWS_COMMAND)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Windows" }));
  expect(screen.getByText(WINDOWS_COMMAND)).toBeDefined();
  expect(screen.queryByText(POSIX_COMMAND)).toBeNull();
  expect(screen.getByText("Run in PowerShell")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "macOS or Linux" }));
  expect(screen.getByText(POSIX_COMMAND)).toBeDefined();
  expect(screen.queryByText(WINDOWS_COMMAND)).toBeNull();
  rendered.unmount();
});

it("[sma:d_machine_add] the machine that joins is shown by name with a link to its settings page, and the launch is not cancelled", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rendered = setup(() => {
    vi.mocked(sdk.hosts.get).mockResolvedValue({
      ...reservedHost,
      name: "Studio PC",
      status: "connected",
      lifecycle: { ...reservedHost.lifecycle, phase: "active" },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(screen.getByText("Studio PC connected")).toBeDefined();
  const link = screen.getByRole("link", { name: /Open machine/u });
  expect(link.getAttribute("href")).toBe("/settings/machines/host-reserved");
  expect(screen.queryByText("Waiting for the machine to connect…")).toBeNull();
  rendered.unmount();
  expect(sdk.hosts.delete).not.toHaveBeenCalled();
});

it("[sma:d_machine_add] a join that ends in a phase other than active says why and offers another try instead of «connected»", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const rendered = setup(() => {
    vi.mocked(sdk.hosts.get).mockResolvedValue({
      ...reservedHost,
      lifecycle: {
        ...reservedHost.lifecycle,
        phase: "removing",
        message: "The machine was removed",
      },
    });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText("The machine was removed")).toBeDefined();
  expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  expect(screen.queryByText(/ connected$/u)).toBeNull();
  expect(screen.queryByRole("link", { name: /Open machine/u })).toBeNull();
  rendered.unmount();
});

it("[sma:m_sw_add_machine] the wizard tells what to run on the second machine, that it is waiting, and which machine must stay on", async () => {
  const rendered = renderAddMachineContent("host_server");
  expect(await screen.findByText(POSIX_COMMAND)).toBeDefined();
  expect(
    screen.getByText(
      "Run this command on the machine you want to add. It installs bb and keeps the machine connected to this server.",
    ),
  ).toBeDefined();
  expect(
    screen.getByText("Waiting for the machine to connect…"),
  ).toBeDefined();
  expect(
    screen.getByText(
      "The new machine will connect to the bb server on Mac mini. Keep that computer on so the new machine can keep working.",
    ),
  ).toBeDefined();
  expect(screen.queryByText(/your bb server\./u)).toBeNull();
  rendered.unmount();
});

it("[sma:m_sw_add_machine] without a primary host the wizard gives the generic server notice and names no machine", async () => {
  const rendered = renderAddMachineContent(null);
  expect(await screen.findByText(POSIX_COMMAND)).toBeDefined();
  expect(
    screen.getByText(
      "The new machine will connect to your bb server. Keep the server machine on so the new machine can keep working.",
    ),
  ).toBeDefined();
  expect(screen.queryByText(/Mac mini|MacBook Pro/u)).toBeNull();
  rendered.unmount();
});

it("[sma:m_sw_add_machine] while the server has no reachable address the wizard asks for one instead of minting an invitation", async () => {
  const rendered = renderAddMachineContent("host_server", UNSET_SERVER_ACCESS);
  expect(await screen.findByText("Set up machine access")).toBeDefined();
  expect(sdk.hosts.experimental_create).not.toHaveBeenCalled();
  expect(screen.queryByText(POSIX_COMMAND)).toBeNull();
  rendered.unmount();
});
