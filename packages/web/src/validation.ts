import { z } from "zod";
import {
  ClientKindSchema,
  isKebabId,
  ScopeSchema,
  StatusSchema,
  TrustSchema,
} from "@boof-runner/shared";
import { ServiceError } from "./service.js";

/** Route params that become filesystem path segments must be kebab-case ids. */
export function paramId(value: string | undefined, what = "id"): string {
  if (!isKebabId(value)) throw new ServiceError(400, `Invalid ${what}`, "invalid_input");
  return value;
}

/** Parse a JSON body against a schema; map failures to a 400 with readable details. */
export async function parseJson<T extends z.ZodType>(
  req: { json: () => Promise<unknown> },
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ServiceError(400, "Request body must be valid JSON", "invalid_input");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ServiceError(
      400,
      "Invalid request body",
      "invalid_input",
      formatIssues(parsed.error),
    );
  }
  return parsed.data;
}

export function formatIssues(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

const labels = z.array(z.string().max(100)).max(50);
const commandRef = z.string().nullable();

export const CreateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().max(500_000).optional(),
    priority: z.number().int().optional(),
    labels: labels.optional(),
    command: commandRef.optional(),
    status: z.enum(["draft", "pending"]).optional(),
    runs: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const UpdateTaskBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().max(500_000).optional(),
    priority: z.number().int().optional(),
    labels: labels.optional(),
    command: commandRef.optional(),
    skip: z.boolean().optional(),
    runs: z.number().int().min(1).max(100).optional(),
    status: StatusSchema.optional(),
  })
  .strict();

export const SkipBody = z.object({ skip: z.boolean() }).strict();
export const ReorderBody = z.object({ order: z.array(z.string()).max(10_000) }).strict();
export const InjectBody = z.object({ prompt: z.string().max(100_000) }).strict();
export const AnswersBody = z.object({ answers: z.string().max(200_000) }).strict();
export const CommandBody = z
  .object({ name: z.string().trim().min(1).max(200), body: z.string().max(200_000).optional() })
  .strict();

const kebabId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
export const CreateClientBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: ClientKindSchema.optional(),
    scopes: z.array(ScopeSchema).min(1),
    projects: z.union([z.literal("*"), z.array(kebabId)]).optional(),
    trust: TrustSchema.optional(),
    /** Duration like "30d"; omitted = never expires. */
    expiresIn: z.string().max(20).optional(),
  })
  .strict();
