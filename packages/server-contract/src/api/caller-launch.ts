import { jsonValueSchema } from "@bb/domain";
import { z } from "zod";

export const CALLER_LAUNCH_METADATA_PLUGIN_ID = "bb-caller-launch";

export const callerLaunchIdSchema = z.string().uuid();
export const callerAttemptIdSchema = z.string().min(1).max(80);
export const callerJobIdSchema = z.string().min(1).max(80);

export const callerLaunchRequestFieldsSchema = z.object({
  experimental_callerLaunchId: callerLaunchIdSchema.optional(),
  experimental_callerAttemptId: callerAttemptIdSchema.optional(),
  experimental_callerJobId: callerJobIdSchema.optional(),
});

export type CallerLaunchRequestFields = z.infer<
  typeof callerLaunchRequestFieldsSchema
>;

export const persistedCallerLaunchIdentitySchema = z
  .object({
    callerLaunchId: callerLaunchIdSchema,
    callerAttemptId: callerAttemptIdSchema,
    callerJobId: callerJobIdSchema.optional(),
    originPluginId: z.string().min(1),
  })
  .strict();

export type PersistedCallerLaunchIdentity = z.infer<
  typeof persistedCallerLaunchIdentitySchema
>;

export const callerLaunchBindingSchema = z
  .object({
    callerAttemptId: callerAttemptIdSchema,
    callerJobId: callerJobIdSchema.nullable(),
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1).nullable(),
    environment: jsonValueSchema,
    environmentId: z.string().min(1).nullable(),
    isolatedSkillDelivery: z.boolean(),
    skillIds: z.array(z.string().min(1)),
    promptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type CallerLaunchBinding = z.infer<typeof callerLaunchBindingSchema>;

export function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeJsonValue(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

export function serializeCallerLaunchBinding(
  binding: CallerLaunchBinding,
): string {
  return canonicalJson(callerLaunchBindingSchema.parse(binding));
}

export function parseCallerLaunchBinding(
  json: string,
): CallerLaunchBinding | null {
  try {
    const parsed = callerLaunchBindingSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const callerLaunchResponseFieldsSchema = z.object({
  experimental_callerLaunchId: callerLaunchIdSchema.optional(),
  experimental_callerAttemptId: callerAttemptIdSchema.optional(),
  experimental_callerJobId: callerJobIdSchema.optional(),
});

export function isReservedCallerLaunchPluginId(pluginId: string): boolean {
  return pluginId === CALLER_LAUNCH_METADATA_PLUGIN_ID;
}

export function parsePersistedCallerLaunchIdentity(
  metadata: unknown,
): PersistedCallerLaunchIdentity | null {
  const parsed = persistedCallerLaunchIdentitySchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

export function refineCallerLaunchRequest(
  value: CallerLaunchRequestFields & { origin?: string },
  addIssue: (message: string, path: Array<string | number>) => void,
): void {
  const hasLaunch = value.experimental_callerLaunchId !== undefined;
  const hasAttempt = value.experimental_callerAttemptId !== undefined;
  const hasJob = value.experimental_callerJobId !== undefined;
  if (!hasLaunch && !hasAttempt && !hasJob) {
    return;
  }
  if (!hasLaunch) {
    addIssue(
      "experimental_callerLaunchId is required when any caller identity field is set",
      ["experimental_callerLaunchId"],
    );
  }
  if (!hasAttempt) {
    addIssue(
      "experimental_callerAttemptId is required when any caller identity field is set",
      ["experimental_callerAttemptId"],
    );
  }
  if (value.origin !== undefined && value.origin !== "plugin") {
    addIssue("caller identity requires origin \"plugin\"", ["origin"]);
  }
}
