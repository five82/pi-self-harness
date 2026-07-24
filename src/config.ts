import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { assertAllowedProfileTools } from "./profile.ts";
import type {
  CommandSpec,
  EvaluationSuite,
  ExecutorRequirement,
  HarnessProfile,
  RepositoryConfig,
  RepositoryDefinition,
  RepositorySafety,
  TaskDefinition,
  VerificationAsset,
  VerificationSpec,
} from "./types.ts";

function fail(context: string, message: string): never {
  throw new Error(`${context}: ${message}`);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(context, "expected an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) fail(context, "expected a non-empty string");
  return value;
}

function optionalString(value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : string(value, context);
}

function positiveNumber(value: unknown, context: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(context, "expected a positive number");
  }
  return value;
}

function strings(value: unknown, context: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(context, "expected an array");
  return value.map((item, index) => string(item, `${context}[${index}]`));
}

function version(value: unknown, context: string): 1 {
  if (value !== 1) fail(context, "unsupported or missing version; expected 1");
  return 1;
}

function commandSpec(value: unknown, context: string): CommandSpec | undefined {
  if (value === undefined) return undefined;
  const input = object(value, context);
  return {
    command: string(input.command, `${context}.command`),
    timeoutSeconds: positiveNumber(input.timeoutSeconds, `${context}.timeoutSeconds`),
  };
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  context: string,
): T[number] | undefined {
  if (value === undefined) return undefined;
  const parsed = string(value, context);
  if (!allowed.includes(parsed)) fail(context, `expected one of: ${allowed.join(", ")}`);
  return parsed as T[number];
}

function verificationAsset(value: unknown, context: string, relativeTo: string): VerificationAsset {
  const input = object(value, context);
  const source = expandPath(string(input.source, `${context}.source`), relativeTo);
  const destination = string(input.destination, `${context}.destination`);
  const normalized = destination.replaceAll("\\", "/");
  if (
    isAbsolute(destination) ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".." ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  ) {
    fail(`${context}.destination`, "must stay inside the task worktree and outside Git metadata");
  }
  if (!existsSync(source) || !statSync(source).isFile()) fail(`${context}.source`, `file does not exist: ${source}`);
  return { source, destination: normalized };
}

function verificationSpec(value: unknown, context: string, relativeTo: string): VerificationSpec | undefined {
  if (value === undefined) return undefined;
  const input = object(value, context);
  const inject = input.inject;
  if (inject !== undefined && !Array.isArray(inject)) fail(`${context}.inject`, "expected an array");
  return {
    command: string(input.command, `${context}.command`),
    timeoutSeconds: positiveNumber(input.timeoutSeconds, `${context}.timeoutSeconds`),
    inject: Array.isArray(inject)
      ? inject.map((item, index) => verificationAsset(item, `${context}.inject[${index}]`, relativeTo))
      : undefined,
  };
}

function executor(value: unknown, context: string): ExecutorRequirement | undefined {
  if (value === undefined) return undefined;
  const input = object(value, context);
  const result: ExecutorRequirement = {
    type: oneOf(input.type, ["local", "container"] as const, `${context}.type`),
    os: oneOf(input.os, ["darwin", "linux"] as const, `${context}.os`),
    arch: optionalString(input.arch, `${context}.arch`),
    requires: strings(input.requires, `${context}.requires`),
    runtime: oneOf(input.runtime, ["podman", "docker"] as const, `${context}.runtime`),
    image: optionalString(input.image, `${context}.image`),
    setupNetwork: oneOf(input.setupNetwork, ["none", "bridge"] as const, `${context}.setupNetwork`),
    agentNetwork: oneOf(input.agentNetwork, ["none", "bridge"] as const, `${context}.agentNetwork`),
  };
  if (result.type === "container" && !result.image) fail(`${context}.image`, "required for container executors");
  if (result.type !== "container" && (result.runtime || result.image || result.setupNetwork || result.agentNetwork)) {
    fail(context, "container settings require type: container");
  }
  return result;
}

function safety(value: unknown, context: string): RepositorySafety | undefined {
  if (value === undefined) return undefined;
  const input = object(value, context);
  return {
    forbiddenCommands: strings(input.forbiddenCommands, `${context}.forbiddenCommands`),
    notes: strings(input.notes, `${context}.notes`),
  };
}

function repository(value: unknown, context: string, relativeTo: string): RepositoryDefinition {
  const input = object(value, context);
  return {
    id: string(input.id, `${context}.id`),
    path: string(input.path, `${context}.path`),
    description: optionalString(input.description, `${context}.description`),
    defaultVerification: verificationSpec(input.defaultVerification, `${context}.defaultVerification`, relativeTo),
    executor: executor(input.executor, `${context}.executor`),
    safety: safety(input.safety, `${context}.safety`),
  };
}

function document(path: string): unknown {
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function expandPath(path: string, relativeTo = process.cwd()): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(relativeTo, path);
}

export function loadRepositoryConfig(path: string): RepositoryConfig {
  const input = object(document(path), path);
  version(input.version, `${path}.version`);
  if (!Array.isArray(input.repositories)) fail(`${path}.repositories`, "expected an array");
  const repositories = input.repositories.map((item, index) =>
    repository(item, `${path}.repositories[${index}]`, dirname(path)),
  );
  const ids = new Set<string>();
  for (const entry of repositories) {
    if (ids.has(entry.id)) fail(path, `duplicate repository id: ${entry.id}`);
    ids.add(entry.id);
    entry.path = expandPath(entry.path, dirname(path));
  }
  return { version: 1, repositories };
}

export function loadTask(path: string): TaskDefinition {
  const input = object(document(path), path);
  version(input.version, `${path}.version`);
  return {
    version: 1,
    id: string(input.id, `${path}.id`),
    repository: string(input.repository, `${path}.repository`),
    summary: string(input.summary, `${path}.summary`),
    prompt: string(input.prompt, `${path}.prompt`),
    baseRevision: string(input.baseRevision, `${path}.baseRevision`),
    setup: commandSpec(input.setup, `${path}.setup`),
    verification: verificationSpec(input.verification, `${path}.verification`, dirname(path)),
    agentTimeoutSeconds: positiveNumber(input.agentTimeoutSeconds, `${path}.agentTimeoutSeconds`),
    executor: executor(input.executor, `${path}.executor`),
    tags: strings(input.tags, `${path}.tags`),
  };
}

export function loadSuite(path: string): EvaluationSuite {
  const input = object(document(path), path);
  version(input.version, `${path}.version`);
  const diagnosis = strings(input.diagnosis, `${path}.diagnosis`) ?? [];
  const validation = strings(input.validation, `${path}.validation`) ?? [];
  const test = strings(input.test, `${path}.test`) ?? [];
  const seen = new Set<string>();
  for (const taskId of [...diagnosis, ...validation, ...test]) {
    if (seen.has(taskId)) fail(path, `task appears in multiple splits: ${taskId}`);
    seen.add(taskId);
  }
  return {
    version: 1,
    id: string(input.id, `${path}.id`),
    description: optionalString(input.description, `${path}.description`),
    diagnosis,
    validation,
    test,
  };
}

export function loadProfile(path: string): HarnessProfile {
  const input = object(document(path), path);
  version(input.version, `${path}.version`);
  const allowed = new Set(["version", "id", "description", "systemPromptAppend", "tools"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "unsupported candidate profile field");
  }
  const tools = strings(input.tools, `${path}.tools`);
  assertAllowedProfileTools(tools, `${path}.tools`);
  return {
    version: 1,
    id: string(input.id, `${path}.id`),
    description: optionalString(input.description, `${path}.description`),
    systemPromptAppend: optionalString(input.systemPromptAppend, `${path}.systemPromptAppend`),
    tools,
  };
}
