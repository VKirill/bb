// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderReact,
  screen,
} from "@testing-library/react";
import { defaultAppSettings } from "@bb/domain";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { resetPluginSlotStoreForTest } from "@/lib/plugin-slots";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { setCompactSecondaryPanelPresentation } from "@/components/ui/secondary-panel-shelf-visibility";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { AppLayout } from "./AppLayout";

function render(ui: ReactNode) {
  return renderReact(ui, { wrapper: createQueryClientTestHarness().wrapper });
}

const SIDEBAR_WIDTH_STORAGE_KEY = "bb.sidebar.width";

const useThreadDetailBootstrapMock = vi.hoisted(() =>
  vi.fn(
    (): {
      data?: { projectId: string };
      isError: boolean;
      isSuccess: boolean;
    } => ({ isError: false, isSuccess: false }),
  ),
);

const sidebarThreadsMock = vi.hoisted(() => {
  const threads: import("@bb/domain").ThreadListEntry[] = [];
  return { threads };
});

vi.mock("./AppLayoutSidebar", async () => {
  const { Sidebar } = await vi.importActual<
    typeof import("@/components/ui/sidebar")
  >("@/components/ui/sidebar");
  return {
    AppLayoutSidebar: ({
      onResizeMouseDown,
    }: {
      onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
    }) => (
      <Sidebar>
        <div data-testid="sidebar-body">App sidebar</div>
        <div data-testid="resize-handle" onMouseDown={onResizeMouseDown} />
      </Sidebar>
    ),
  };
});

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      experiments: {},
      generalSettings: defaultAppSettings,
      keybindings: [
        {
          command: "app.back",
          desktopOnly: false,
          shortcut: {
            key: "Escape",
            mod: false,
            meta: false,
            control: false,
            alt: false,
            shift: false,
          },
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ],
    },
  }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: "unavailable" }),
}));

vi.mock("@/hooks/usePluginSafeModeCommands", () => ({
  usePluginSafeModeCommands: () => undefined,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  ProjectActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  ThreadActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/dialogs/ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
}));

vi.mock("./AppPageHeader", () => ({
  HEADER_ICON_BUTTON_CLASS: "header-icon-button",
  AppPageHeader: () => <header />,
}));

vi.mock("@/lib/bb-desktop", () => ({
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS: "",
  CHROME_ROW_CLASS: "",
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  MACOS_CHROME_CONTROL_AXIS_CLASS: "",
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS: "",
  MACOS_TITLE_BAR_CONTROL_AXIS_CLASS: "",
  MACOS_TITLE_BAR_CONTROL_SIZE_CLASS: "",
  MACOS_TITLE_BAR_PINNED_TOGGLE_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_PADDING_CLASS: "",
  MACOS_WINDOW_DRAG_CLASS: "",
  MACOS_WINDOW_NO_DRAG_CLASS: "",
  getBbDesktopInfo: () => null,
  shouldReserveMacosTrafficLights: () => false,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/lib/favicon-color-preference", () => ({
  useFaviconBadge: vi.fn(),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    isCreating: false,
    platform: "darwin",
    projectPathDialog: { onOpenChange: vi.fn(), target: null },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      sections: [
        { id: "sec_planning", name: "Planning" },
        { id: "sec_building", name: "Building" },
      ],
      personalProject: {
        id: "proj_personal",
        kind: "personal",
        name: "Personal",
        sources: [],
        threads: sidebarThreadsMock.threads,
        defaultExecutionOptions: null,
        createdAt: 1,
        updatedAt: 1,
      },
      projects: [],
    },
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: () => ({ data: undefined }),
  didThreadDetailBootstrapRefreshAfterMount: () => true,
  useThread: () => ({ data: undefined }),
  useThreadDetailBootstrap: useThreadDetailBootstrapMock,
  useThreadPendingInteractions: () => ({ data: undefined }),
}));


function widthVar(element: Element | null): string {
  if (!(element instanceof HTMLElement)) throw new Error("missing element");
  return element.style.getPropertyValue("--sidebar-width");
}

function Content() {
  return <div data-testid="routed-view">the open view</div>;
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <AppCommandProvider>
        <AppLayout>
          <Content />
        </AppLayout>
      </AppCommandProvider>
    </MemoryRouter>,
  );
}

let frameCallbacks: FrameRequestCallback[] = [];

function flushFrames() {
  const callbacks = frameCallbacks;
  frameCallbacks = [];
  act(() => {
    for (const callback of callbacks) callback(0);
  });
}

function dragSidebar(delta: number) {
  const handle = screen.getByTestId("resize-handle");
  act(() => {
    fireEvent.mouseDown(handle, { clientX: 320 });
  });
  act(() => {
    fireEvent.mouseMove(window, { clientX: 320 + delta });
  });
  flushFrames();
  act(() => {
    fireEvent.mouseUp(window);
  });
}

function gap(): Element | null {
  return document.querySelector('[data-sidebar="gap"]');
}

beforeEach(() => {
  sidebarThreadsMock.threads = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  frameCallbacks = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    frameCallbacks.push(cb);
    return frameCallbacks.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  setCompactSecondaryPanelPresentation("closed");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("[sma:m_ws_shell] dragging the sidebar edge changes its width and keeps the open view mounted as the same element, and the new width is remembered", () => {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "320");
  renderLayout();
  const view = screen.getByTestId("routed-view");
  expect(widthVar(gap())).toBe("320px");

  dragSidebar(40);

  expect(widthVar(gap())).toBe("360px");
  expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("360");
  expect(screen.getByTestId("routed-view")).toBe(view);
  expect(view.isConnected).toBe(true);
});

it("[sma:m_ws_shell] the width is held between 240 and 460 px however far the edge is dragged, both on screen and in what is remembered", () => {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "320");
  renderLayout();

  dragSidebar(900);
  expect(widthVar(gap())).toBe("460px");
  expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("460");

  dragSidebar(-900);
  expect(widthVar(gap())).toBe("240px");
  expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("240");
});

it("[sma:m_ws_shell] a reopened window takes the remembered width, clamped, and falls back to 320 px when the remembered value is not a number", () => {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "400");
  const first = renderLayout();
  expect(widthVar(gap())).toBe("400px");
  first.unmount();

  window.sessionStorage.clear();
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "9999");
  const second = renderLayout();
  expect(widthVar(gap())).toBe("460px");
  second.unmount();

  window.sessionStorage.clear();
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "50");
  const third = renderLayout();
  expect(widthVar(gap())).toBe("240px");
  third.unmount();

  window.sessionStorage.clear();
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "wide");
  renderLayout();
  expect(widthVar(gap())).toBe("320px");
});
