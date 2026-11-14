import { getProject, listPublicProjects } from "@bb/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHost,
  seedPrimaryHost,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  sources: z.array(z.object({ id: z.string(), path: z.string().nullable() })),
});

describe("projects register (core)", () => {
  it("[sma:m_pj_add] adding a project mints its id on the server and stores the name and the folder as data; two folders with one name are two projects", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-add-project" });
      seedPrimaryHost(harness.deps, host.id);
      const add = async (name: string, path: string) => {
        const response = await harness.app.request("/api/v1/projects", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            source: { type: "local_path", hostId: host.id, path },
          }),
        });
        expect(response.status).toBe(201);
        return projectSchema.parse(await readJson(response));
      };

      const first = await add("Same Name", "/tmp/add-project-one");
      const second = await add("Same Name", "/tmp/add-project-two");

      expect(first.id).toMatch(/^proj_/u);
      expect(second.id).toMatch(/^proj_/u);
      expect(first.id).not.toBe(second.id);
      expect(first.name).toBe("Same Name");
      expect(first.sources.map((source) => source.path)).toEqual([
        "/tmp/add-project-one",
      ]);
      expect(second.sources.map((source) => source.path)).toEqual([
        "/tmp/add-project-two",
      ]);
      expect(getProject(harness.db, first.id)?.name).toBe("Same Name");
      expect(
        listPublicProjects(harness.db)
          .map((project) => project.id)
          .sort(),
      ).toEqual([first.id, second.id].sort());

      // the same folder again is the same project, not a new one
      const again = await add("Renamed At Add", "/tmp/add-project-one");
      expect(again.id).toBe(first.id);
      expect(listPublicProjects(harness.db)).toHaveLength(2);
    });
  });

  it("[sma:m_pj_default] a project made without a choice of folder gets its folder as the default source", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-default-source" });
      seedPrimaryHost(harness.deps, host.id);
      const created = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Defaulted",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/default-source",
          },
        }),
      });
      expect(created.status).toBe(201);
      const body = z
        .object({
          id: z.string(),
          sources: z.array(
            z.object({
              path: z.string().nullable(),
              isDefault: z.boolean(),
              hostId: z.string().nullable().optional(),
            }),
          ),
        })
        .parse(await readJson(created));
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0]).toMatchObject({
        path: "/tmp/default-source",
        isDefault: true,
      });
      const read = await harness.app.request(`/api/v1/projects/${body.id}`);
      expect(
        (
          (await readJson(read)) as {
            sources: Array<{ isDefault: boolean }>;
          }
        ).sources.map((source) => source.isDefault),
      ).toEqual([true]);
    });
  });

  it("[sma:m_pj_select] every thread is bound to its own project, and the project list never mixes them: there is no switch to move the work", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-bound-projects" });
      seedPrimaryHost(harness.deps, host.id);
      const make = async (name: string, path: string) =>
        projectSchema.parse(
          await readJson(
            await harness.app.request("/api/v1/projects", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                name,
                source: { type: "local_path", hostId: host.id, path },
              }),
            }),
          ),
        );
      const left = await make("Left", "/tmp/bound-left");
      const right = await make("Right", "/tmp/bound-right");
      const threadIn = (project: { id: string }, path: string) =>
        seedThread(harness.deps, {
          environmentId: seedEnvironment(harness.deps, {
            hostId: host.id,
            projectId: project.id,
            path,
          }).id,
          projectId: project.id,
          status: "idle",
        });
      const leftThread = threadIn(left, "/tmp/bound-left");
      const rightThread = threadIn(right, "/tmp/bound-right");

      const listed = z
        .array(
          z.object({
            id: z.string(),
            threads: z.array(z.object({ id: z.string() })),
          }),
        )
        .parse(
          await readJson(
            await harness.app.request("/api/v1/projects?include=threads"),
          ),
        );
      const threadsOf = (id: string) =>
        listed.find((project) => project.id === id)?.threads.map((t) => t.id);
      expect(threadsOf(left.id)).toEqual([leftThread.id]);
      expect(threadsOf(right.id)).toEqual([rightThread.id]);
    });
  });

  it("[sma:m_pj_rename] renaming changes the name and never the id, because threads and sources reference the id", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-rename-project" });
      seedPrimaryHost(harness.deps, host.id);
      const created = await harness.app.request("/api/v1/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Before",
          source: {
            type: "local_path",
            hostId: host.id,
            path: "/tmp/rename-project",
          },
        }),
      });
      const project = projectSchema.parse(await readJson(created));
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/rename-project",
      });
      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });

      const renamed = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "After" }),
        },
      );
      expect(renamed.status).toBe(200);
      const body = projectSchema.parse(await readJson(renamed));
      expect(body.id).toBe(project.id);
      expect(body.name).toBe("After");
      expect(body.sources).toEqual(project.sources);

      expect(getProject(harness.db, project.id)?.name).toBe("After");
      expect(listPublicProjects(harness.db).map((row) => row.id)).toEqual([
        project.id,
      ]);
      const read = projectSchema.parse(
        await readJson(
          await harness.app.request(`/api/v1/projects/${project.id}`),
        ),
      );
      expect(read).toMatchObject({ id: project.id, name: "After" });
      expect(thread.projectId).toBe(project.id);

      const missing = await harness.app.request(
        "/api/v1/projects/proj_no_such_project",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Ghost" }),
        },
      );
      expect(missing.status).toBe(404);
    });
  });
});
