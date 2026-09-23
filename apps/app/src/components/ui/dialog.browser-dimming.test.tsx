// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@bb/shared-ui/dialog";
import { useIsBrowserDimmingModalOpen } from "@/hooks/useBrowserDimmingModal";

function DimProbe() {
  return (
    <span data-testid="dim">
      {useIsBrowserDimmingModalOpen() ? "dimmed" : "clear"}
    </span>
  );
}

afterEach(cleanup);

it("an app Dialog dims the browser through the shared-ui env seam", async () => {
  const { rerender } = render(
    <>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Seam check</DialogTitle>
        </DialogContent>
      </Dialog>
      <DimProbe />
    </>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("dim").textContent).toBe("dimmed"),
  );

  rerender(
    <>
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Seam check</DialogTitle>
        </DialogContent>
      </Dialog>
      <DimProbe />
    </>,
  );

  await waitFor(() =>
    expect(screen.getByTestId("dim").textContent).toBe("clear"),
  );
});

it("hides native browser views for vendored plugin dialogs and restores them after closing", async () => {
  const { rerender } = render(
    <>
      <div role="dialog" data-state="open">
        Plugin rules
      </div>
      <DimProbe />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("dim").textContent).toBe("dimmed"),
  );
  rerender(
    <>
      <div role="dialog" data-state="closed">
        Plugin rules
      </div>
      <DimProbe />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("dim").textContent).toBe("clear"),
  );
});

it("does not hide native browser views for menus", async () => {
  render(
    <>
      <div role="menu" data-state="open">
        Context menu
      </div>
      <DimProbe />
    </>,
  );
  await waitFor(() =>
    expect(screen.getByTestId("dim").textContent).toBe("clear"),
  );
});
