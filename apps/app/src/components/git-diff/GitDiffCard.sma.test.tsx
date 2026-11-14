// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DiffPresentation } from "@bb/shared-ui/git-diff/renderers";
import { parseGitDiffFiles } from "@bb/shared-ui/git-diff/parsing";
import { GitDiffCard } from "./GitDiffCard";

const PRESENTATION: DiffPresentation = {
  view: "unified",
  overflow: "scroll",
  showLineNumbers: true,
};

const SESSION_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/auth/session.ts
+++ b/src/auth/session.ts
@@ -1,6 +1,8 @@
 export function createSession(user: User): Session {
   const token = signToken(user.id);
-  const expiresAt = Date.now() + ONE_HOUR;
+  const expiresAt = Date.now() + SESSION_TTL_MS;
+  const refreshToken = signRefreshToken(user.id);
   return {
     token,
+    refreshToken,
     userId: user.id,
`;

const NEW_FILE_DIFF = `diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/src/auth/refresh.ts
@@ -0,0 +1,3 @@
+import { signToken } from "./token";
+
+export const TTL = 1;
`;

const EMPTY_RENAME_DIFF = `diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
`;

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function header(diff: string) {
  const [file] = parseGitDiffFiles(diff);
  const view = render(<GitDiffCard fileDiff={file!} presentation={PRESENTATION} />);
  return view.container.textContent ?? "";
}

it("[sma:sc_diff] a changed file's card names the file and counts its added and removed lines", () => {
  const text = header(SESSION_DIFF);
  expect(text).toContain("src/auth/session.ts");
  expect(text).toContain("+3");
  expect(text).toContain("-1");
});

it("[sma:sc_diff] a new file's card counts only added lines", () => {
  const text = header(NEW_FILE_DIFF);
  expect(text).toContain("src/auth/refresh.ts");
  expect(text).toContain("+3");
  expect(text).not.toMatch(/-\d/u);
});

it("[sma:sc_diff] a rename without edits shows the old and the new name and counts no changed line", () => {
  const text = header(EMPTY_RENAME_DIFF);
  expect(text).toContain("old/name.ts");
  expect(text).toContain("new/name.ts");
  expect(text).toContain("+0 -0");
});
