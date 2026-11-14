// @vitest-environment jsdom

import { makeHost } from "@bb/test-helpers/domain-fixtures";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { MachineRemoveDialog } from "./MachineRemoveDialog";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: { delete: vi.fn() },
    threads: {
      list: vi.fn(async () => []),
      count: vi.fn(async () => ({ total: 0 })),
    },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(
  target: ReturnType<typeof makeHost>,
  handlers: {
    onOpenChange?: (open: boolean) => void;
    onRemoved?: (host: ReturnType<typeof makeHost>) => void;
  } = {},
) {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MachineRemoveDialog
      target={target}
      onOpenChange={handlers.onOpenChange ?? (() => {})}
      onRemoved={handlers.onRemoved}
    />,
    { wrapper },
  );
}

it("[sma:d_machine_remove] pressing Remove machine deletes that machine without force, then closes the dialog and reports the host", async () => {
  vi.mocked(sdk.hosts.delete).mockResolvedValue({ ok: true });
  const host = makeHost({ id: "host_laptop", name: "MacBook Pro" });
  const onOpenChange = vi.fn();
  const onRemoved = vi.fn();
  renderDialog(host, { onOpenChange, onRemoved });

  expect(await screen.findByText("Remove MacBook Pro?")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Remove machine" }));

  await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(host));
  expect(sdk.hosts.delete).toHaveBeenCalledTimes(1);
  expect(sdk.hosts.delete).toHaveBeenCalledWith({
    hostId: "host_laptop",
    force: false,
  });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("[sma:d_machine_remove] a machine whose cleanup failed while offline is removed with force, and the button says so", async () => {
  vi.mocked(sdk.hosts.delete).mockResolvedValue({ ok: true });
  const host = makeHost({
    id: "host_gone",
    name: "Old box",
    status: "disconnected",
    lifecycle: {
      phase: "removing",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: { status: "failed" },
    } as never,
  });
  renderDialog(host);

  fireEvent.click(await screen.findByRole("button", { name: "Remove anyway" }));
  await waitFor(() => expect(sdk.hosts.delete).toHaveBeenCalledTimes(1));
  expect(sdk.hosts.delete).toHaveBeenCalledWith({
    hostId: "host_gone",
    force: true,
  });
  expect(screen.queryByRole("button", { name: "Remove machine" })).toBeNull();
});

it("[sma:d_machine_remove] a refused delete keeps the dialog open, says why and does not report the host as removed", async () => {
  vi.mocked(sdk.hosts.delete).mockRejectedValue(new Error("machine is busy"));
  const host = makeHost({ id: "host_busy", name: "Busy box" });
  const onOpenChange = vi.fn();
  const onRemoved = vi.fn();
  renderDialog(host, { onOpenChange, onRemoved });

  fireEvent.click(await screen.findByRole("button", { name: "Remove machine" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("machine is busy");
  expect(onRemoved).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
});
