import { describe, expect, it } from "vitest";
import {
  pathFromComposerEnvironmentRequest,
  resolveComposerEnvironmentProvenance,
} from "./composer-environment-provenance";

const projectSources = [
  {
    id: "source-mini",
    projectId: "project-1",
    type: "local_path" as const,
    hostId: "host-mini",
    path: "/Users/example/Project",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  },
];

describe("composer environment provenance", () => {
  it("exposes the native Project checkout request and its resolved host source", () => {
    const request = {
      type: "provider" as const,
      environmentProviderId: "project-checkout",
      machine: { type: "existing" as const, hostId: "host-mini" },
      inputs: {},
    };

    expect(pathFromComposerEnvironmentRequest(request)).toBeUndefined();
    expect(
      resolveComposerEnvironmentProvenance({
        projectId: "project-1",
        projectSources,
        hostId: request.machine.hostId,
        path: undefined,
      }),
    ).toEqual({
      projectId: "project-1",
      sectionId: null,
      projectSourceId: "source-mini",
      hostId: "host-mini",
      path: "/Users/example/Project",
    });
  });

  it("keeps an explicit provider path and does not misattribute another project source", () => {
    const request = {
      type: "provider" as const,
      environmentProviderId: "project-checkout",
      machine: { type: "existing" as const, hostId: "host-mini" },
      inputs: { path: "/tmp/other-checkout" },
    };

    const path = pathFromComposerEnvironmentRequest(request);
    expect(path).toBe("/tmp/other-checkout");
    expect(
      resolveComposerEnvironmentProvenance({
        projectId: "project-1",
        projectSources,
        hostId: request.machine.hostId,
        path,
      }),
    ).toEqual({
      projectId: "project-1",
      sectionId: null,
      hostId: "host-mini",
      path: "/tmp/other-checkout",
    });
  });

  it("preserves a confirmed host workspace path and omits unknown host paths", () => {
    expect(
      pathFromComposerEnvironmentRequest({
        type: "host",
        hostId: "host-mini",
        workspace: { type: "unmanaged", path: "/Users/example/Project" },
      }),
    ).toBe("/Users/example/Project");
    expect(
      resolveComposerEnvironmentProvenance({
        projectId: "project-1",
        projectSources,
        hostId: undefined,
        path: undefined,
      }),
    ).toEqual({ projectId: "project-1", sectionId: null });
  });
});
