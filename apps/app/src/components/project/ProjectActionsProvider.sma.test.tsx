// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeProjectResponse } from "@/test/fixtures/projects";
import {
  ProjectActionsProvider,
  useProjectActions,
} from "./ProjectActionsProvider";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    projects: { update: vi.fn(), delete: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock("@/hooks/useRouteState", () => ({
  useRouteState: () => ({ projectId: null }),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  useLocalPathPicker: () => ({
    openPicker: vi.fn(),
    platform: null,
    hostId: null,
    hostName: null,
    projectPathDialog: { target: null, onOpenChange: vi.fn() },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/components/dialogs/ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
}));

vi.mock("@/components/dialogs/ProjectDeleteDialog", () => ({
  ProjectDeleteDialog: () => null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const project = makeProjectResponse({ id: "proj_alpha", name: "Alpha" });

function RenameButton() {
  const { requestRename } = useProjectActions();
  return (
    <button type="button" onClick={() => requestRename(project)}>
      open rename
    </button>
  );
}

function renderProvider() {
  const { wrapper } = createQueryClientTestHarness();
  return render(
    <MemoryRouter>
      <ProjectActionsProvider>
        <RenameButton />
      </ProjectActionsProvider>
    </MemoryRouter>,
    { wrapper },
  );
}

it("[sma:d_project_rename] the rename dialog opens on the current name and saving sends the trimmed new name for that project id, then closes", async () => {
  vi.mocked(sdk.projects.update).mockResolvedValue({
    ...project,
    name: "Beta",
  });
  renderProvider();
  fireEvent.click(screen.getByRole("button", { name: "open rename" }));

  const input = (await screen.findByLabelText("Project name")) as HTMLInputElement;
  expect(input.value).toBe("Alpha");
  fireEvent.change(input, { target: { value: "  Beta  " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

  await waitFor(() => expect(sdk.projects.update).toHaveBeenCalledTimes(1));
  expect(sdk.projects.update).toHaveBeenCalledWith({
    projectId: "proj_alpha",
    name: "Beta",
  });
  await waitFor(() => expect(screen.queryByLabelText("Project name")).toBeNull());
});

it("[sma:d_project_rename] an empty name is refused in the dialog and nothing is sent; the name, not the id, is what changes", async () => {
  renderProvider();
  fireEvent.click(screen.getByRole("button", { name: "open rename" }));

  const input = await screen.findByLabelText("Project name");
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename project" }));

  expect(await screen.findByText("Project name cannot be empty.")).toBeDefined();
  expect(sdk.projects.update).not.toHaveBeenCalled();
});
