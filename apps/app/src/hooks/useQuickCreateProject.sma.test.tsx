// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useQuickCreateProject } from "./useQuickCreateProject";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  navigate: vi.fn(),
  pathname: "/",
  setRootComposeProjectId: vi.fn(),
  closeDialog: vi.fn(),
  submit: null as null | ((params: unknown) => void),
}));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: mocks.pathname }),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/mutations/project-mutations", () => ({
  useCreateProject: () => ({ isPending: false, mutate: mocks.mutate }),
}));

vi.mock("@/hooks/queries/host-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/host-queries")>()),
  useHosts: () => ({
    data: [makeHost({ id: "host_atum", name: "atum" })],
    isPending: false,
  }),
}));

vi.mock("@/hooks/useLocalPathPicker", () => ({
  useLocalPathPicker: (options: { submit: (params: unknown) => void }) => {
    mocks.submit = options.submit;
    return {
      isAvailable: true,
      hostId: "host_atum",
      hostName: "atum",
      openPathEntry: vi.fn(),
      openPicker: vi.fn(),
      platform: "linux",
      projectPathDialog: {
        isOpen: false,
        onClose: vi.fn(),
        onOpen: vi.fn(),
        onOpenChange: vi.fn(),
        target: null,
      },
      submitProjectPath: vi.fn(),
    };
  },
}));

vi.mock("@/lib/root-compose-selection", () => ({
  useSetRootComposeProjectId: () => mocks.setRootComposeProjectId,
}));

beforeEach(() => {
  mocks.pathname = "/";
  mocks.submit = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function submit(params: {
  path: string;
  hostId: string;
  target: { kind: string };
}) {
  renderHook(() => useQuickCreateProject());
  act(() => mocks.submit!({ ...params, closeDialog: mocks.closeDialog }));
}

it("[sma:d_project_add] a folder picked for a new project creates a project named after the folder, with that folder on that machine as its source", () => {
  submit({
    path: "/home/me/projects/My App",
    hostId: "host_atum",
    target: { kind: "create" },
  });

  expect(mocks.mutate).toHaveBeenCalledTimes(1);
  const [request] = mocks.mutate.mock.calls[0]!;
  expect(request).toEqual({
    name: "My App",
    source: {
      type: "local_path",
      hostId: "host_atum",
      path: "/home/me/projects/My App",
    },
  });
});

it("[sma:d_project_add] once the project exists the dialog closes, the new project becomes the compose project and the window goes to compose", () => {
  submit({
    path: "/srv/api",
    hostId: "host_atum",
    target: { kind: "create" },
  });
  const [, callbacks] = mocks.mutate.mock.calls[0]!;
  expect(mocks.closeDialog).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();

  act(() => callbacks.onSuccess({ id: "proj_new" }));

  expect(mocks.closeDialog).toHaveBeenCalledTimes(1);
  expect(mocks.setRootComposeProjectId).toHaveBeenCalledWith("proj_new");
  expect(mocks.navigate).toHaveBeenCalledTimes(1);
  expect(mocks.navigate.mock.calls[0]![1]).toEqual({ replace: true });
});

it("[sma:d_project_add] a folder entered for another purpose (adding a source) and a path with no usable name create nothing", () => {
  submit({
    path: "/srv/api",
    hostId: "host_atum",
    target: { kind: "add-source" },
  });
  expect(mocks.mutate).not.toHaveBeenCalled();

  submit({ path: "/", hostId: "host_atum", target: { kind: "create" } });
  expect(mocks.mutate).not.toHaveBeenCalled();
});
