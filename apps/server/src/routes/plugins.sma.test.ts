import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestAppHarness, type TestAppHarness } from "../../test/helpers/test-app.js";

// SMA map, region 9, n775 (d_assets): «GET /assets/:file. Static build files.» In BB the window's built files of a
// plugin are served by the core: GET /api/v1/plugins/:id/assets/:file answers with the plugin's own built bundle, and
// nothing else of the plugin folder is reachable through it.

const BASE = "http://127.0.0.1:3334";

async function writeAppPlugin(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-sma-assets",
      version: "0.1.0",
      bb: {
        name: "Assets fixture",
        description: "A plugin with a window bundle.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        app: "./app.tsx",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), "export default function plugin() {}");
  await writeFile(
    join(rootDir, "app.tsx"),
    `export default function App() {\n  return <div className="line-clamp-2">sma assets</div>;\n}\n`,
  );
}

describe("a plugin's built window files (core: routes/plugins GET /plugins/:id/assets/:file)", () => {
  let harness: TestAppHarness;

  beforeEach(async () => {
    harness = await createTestAppHarness();
  });

  afterEach(async () => {
    await harness.pluginService.stop();
    await harness.cleanup();
  });

  it("[sma:d_assets] app.js and app.css answer 200 with the plugin's built files; any other name is 404", async () => {
    const rootDir = join(harness.config.dataDir, "fixtures", "bb-plugin-sma-assets");
    await writeAppPlugin(rootDir);
    const entry = await harness.pluginService.installPath(rootDir);
    expect(entry.status).toBe("running");

    const js = await harness.app.request(`${BASE}/api/v1/plugins/${entry.id}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const jsText = await js.text();
    expect(jsText).toBe(await readFile(join(rootDir, "dist", "app.js"), "utf8"));
    expect(jsText).toContain("sma assets");

    const css = await harness.app.request(`${BASE}/api/v1/plugins/${entry.id}/assets/app.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe(await readFile(join(rootDir, "dist", "app.css"), "utf8"));

    for (const name of ["server.js", "package.json", "app.meta.json"]) {
      const other = await harness.app.request(`${BASE}/api/v1/plugins/${entry.id}/assets/${name}`);
      expect({ name, status: other.status }).toEqual({ name, status: 404 });
    }
    expect((await harness.app.request(`${BASE}/api/v1/plugins/sma-no-such-plugin/assets/app.js`)).status).toBe(404);
  }, 120_000);
});
