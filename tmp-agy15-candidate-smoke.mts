import { parseBbAppManagedConfig } from "@bb/config/bb-app-managed-config";

type Warn = { fields: Record<string, unknown>; message: string };

function parseWithWarnings(raw: unknown): {
  parsed: ReturnType<typeof parseBbAppManagedConfig>;
  warnings: Warn[];
} {
  const warnings: Warn[] = [];
  const parsed = parseBbAppManagedConfig(raw, {
    logger: {
      warn(fields: Record<string, unknown>, message: string) {
        warnings.push({ fields, message });
      },
    },
  });
  return { parsed, warnings };
}

const keepRaw = JSON.parse(process.env.AGY15_KEEP_JSON ?? "null");
const rejectRaw = JSON.parse(process.env.AGY15_REJECT_JSON ?? "null");
if (keepRaw === null || rejectRaw === null) {
  throw new Error("AGY15_KEEP_JSON / AGY15_REJECT_JSON required");
}

const keep = parseWithWarnings(keepRaw);
const roots = keep.parsed.customAcpAgents?.[0]?.nativeSkillRoots;
if (keep.warnings.length !== 0) {
  throw new Error(`keep fixture warned: ${JSON.stringify(keep.warnings)}`);
}
if (!Array.isArray(keep.parsed.customAcpAgents) || keep.parsed.customAcpAgents.length !== 1) {
  throw new Error("keep fixture dropped customAcpAgents");
}
const user0 = Array.isArray(roots?.user) ? roots.user[0] : undefined;
const project0 = Array.isArray(roots?.project) ? roots.project[0] : undefined;
if (
  typeof user0 !== "object" ||
  user0 === null ||
  !("recursive" in user0) ||
  user0.recursive !== true
) {
  throw new Error("keep fixture lost user recursive");
}
if (
  typeof project0 !== "object" ||
  project0 === null ||
  !("ancestors" in project0) ||
  project0.ancestors !== true
) {
  throw new Error("keep fixture lost project ancestors");
}

const reject = parseWithWarnings(rejectRaw);
if (reject.parsed.customAcpAgents?.length) {
  throw new Error("reject fixture kept unsafe user ancestors");
}
if (reject.warnings.length !== 1) {
  throw new Error(`reject expected 1 warning, got ${reject.warnings.length}`);
}

process.stdout.write(
  JSON.stringify(
    {
      keepAgents: keep.parsed.customAcpAgents?.length ?? 0,
      keepUserRecursive: true,
      keepProjectAncestors: true,
      rejectAgents: reject.parsed.customAcpAgents?.length ?? 0,
      rejectWarning: reject.warnings[0]?.message,
    },
    null,
    2,
  ) + "\n",
);
