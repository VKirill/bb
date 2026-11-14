import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginApp } from "./build-plugin-app.js";
import { resolvePluginBuildToolchain } from "./toolchain.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixturePlugin(appSource: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bb-plugin-dist-swap-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-dist-swap-fixture",
      version: "0.0.0",
      bb: {
        name: "Dist swap fixture",
        description: "Builds its window twice.",
        branding: { icon: "Zap" },
        server: "./server.ts",
        app: "./app.tsx",
      },
    }),
  );
  await writeFile(
    join(dir, "server.ts"),
    "export default function plugin() {}\n",
  );
  await writeFile(join(dir, "app.tsx"), appSource);
  return dir;
}

const app = (marker: string) =>
  `export default function App() { return <p>${marker}</p>; }\n`;

describe("plugin window distribution (SMA proofs)", () => {
  it("[sma:k_lib_spadist] the window is built aside and swapped in whole: a rebuild replaces app.js, app.css and app.meta.json together, and a build that fails leaves the served files as they were with no staging folder left behind", async () => {
    const dir = await fixturePlugin(app("first-marker"));
    const toolchain = await resolvePluginBuildToolchain(
      join(tmpdir(), "bb-toolchain-unused"),
    );

    const first = await buildPluginApp(dir, "0.9.0-test", toolchain, {
      minify: false,
    });
    const firstJs = await readFile(first.jsPath, "utf8");
    expect(firstJs).toContain("first-marker");
    expect((await readdir(join(dir, "dist"))).sort()).toEqual([
      "app.css",
      "app.js",
      "app.meta.json",
    ]);

    await writeFile(join(dir, "app.tsx"), app("second-marker"));
    await buildPluginApp(dir, "0.9.0-test", toolchain, { minify: false });
    const secondJs = await readFile(first.jsPath, "utf8");
    expect(secondJs).toContain("second-marker");
    expect(secondJs).not.toContain("first-marker");
    expect((await readdir(join(dir, "dist"))).sort()).toEqual([
      "app.css",
      "app.js",
      "app.meta.json",
    ]);

    const servedBefore = await readFile(first.jsPath, "utf8");
    const metaBefore = await readFile(first.metaPath, "utf8");
    await writeFile(join(dir, "app.tsx"), "export default function App( {\n");
    await expect(
      buildPluginApp(dir, "0.9.0-test", toolchain, { minify: false }),
    ).rejects.toThrow();
    expect(await readFile(first.jsPath, "utf8")).toBe(servedBefore);
    expect(await readFile(first.metaPath, "utf8")).toBe(metaBefore);
    expect((await readdir(join(dir, "dist"))).sort()).toEqual([
      "app.css",
      "app.js",
      "app.meta.json",
    ]);
  }, 60_000);
});
