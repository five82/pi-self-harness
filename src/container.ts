import { getgid, getuid } from "node:process";
import type { ContainerNetwork, ContainerRuntime, ProcessResult } from "./types.ts";
import { runProcess } from "./process.ts";

const CONTAINER_CWD = "/workspace";

export interface ContainerSpec {
  runtime: ContainerRuntime;
  image: string;
  name: string;
  worktree: string;
  cacheDirectory: string;
  network: ContainerNetwork;
}

export function buildContainerRunArgs(spec: ContainerSpec): string[] {
  const args = [
    "run",
    "--detach",
    "--rm",
    "--name",
    spec.name,
    "--network",
    spec.network,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=512",
    "--workdir",
    CONTAINER_CWD,
    "--volume",
    `${spec.worktree}:${CONTAINER_CWD}:rw`,
    "--volume",
    `${spec.cacheDirectory}:/cache:rw`,
    "--env",
    "HOME=/tmp",
    "--env",
    "XDG_CACHE_HOME=/cache/xdg",
    "--env",
    "npm_config_cache=/cache/npm",
    "--env",
    "GOMODCACHE=/cache/go-mod",
    "--env",
    "GOCACHE=/cache/go-build",
    "--env",
    "UV_CACHE_DIR=/cache/uv",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=2147483648",
  ];

  if (spec.runtime === "podman") args.push("--userns=keep-id");
  else if (typeof getuid === "function" && typeof getgid === "function") {
    args.push("--user", `${getuid()}:${getgid()}`);
  }

  args.push("--entrypoint", "/bin/sh", spec.image, "-c", "while :; do sleep 3600; done");
  return args;
}

export async function startContainer(spec: ContainerSpec, cwd: string): Promise<ProcessResult> {
  return runProcess({
    command: spec.runtime,
    args: buildContainerRunArgs(spec),
    cwd,
    timeoutMs: 300_000,
  });
}

export async function stopContainer(
  runtime: ContainerRuntime,
  name: string,
  cwd: string,
): Promise<ProcessResult> {
  return runProcess({ command: runtime, args: ["rm", "--force", name], cwd, timeoutMs: 120_000 });
}

export async function runContainerShell(options: {
  runtime: ContainerRuntime;
  name: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  stdoutPath?: string;
  stderrPath?: string;
}): Promise<ProcessResult> {
  return runProcess({
    command: options.runtime,
    args: ["exec", "--workdir", CONTAINER_CWD, options.name, "/bin/sh", "-lc", options.command],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    stdoutPath: options.stdoutPath,
    stderrPath: options.stderrPath,
  });
}

export const CONTAINER_WORKSPACE = CONTAINER_CWD;
