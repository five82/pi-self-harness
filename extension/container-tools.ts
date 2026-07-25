import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

interface RuntimeConfig {
  runtime: "podman" | "docker";
  container: string;
  hostCwd: string;
  guestCwd: string;
}

function loadConfig(): RuntimeConfig {
  const encoded = process.env.PI_SELF_HARNESS_CONTAINER;
  if (!encoded) throw new Error("PI_SELF_HARNESS_CONTAINER is not set");
  const value = JSON.parse(encoded) as Partial<RuntimeConfig>;
  if ((value.runtime !== "podman" && value.runtime !== "docker") || !value.container || !value.hostCwd || !value.guestCwd) {
    throw new Error("PI_SELF_HARNESS_CONTAINER is invalid");
  }
  return value as RuntimeConfig;
}

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isInside(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function guestPath(config: RuntimeConfig, input: string): string {
  const value = stripAtPrefix(input.trim());
  if (!value) return config.guestCwd;
  if (path.isAbsolute(value)) {
    if (isInside(config.hostCwd, value)) {
      const relative = path.relative(config.hostCwd, value).split(path.sep).join(path.posix.sep);
      return relative ? path.posix.join(config.guestCwd, relative) : config.guestCwd;
    }
    return path.posix.resolve("/", value.split(path.sep).join(path.posix.sep));
  }
  return path.posix.resolve(config.guestCwd, value.split(path.sep).join(path.posix.sep));
}

interface ExecOptions {
  args: string[];
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onData?: (chunk: Buffer) => void;
}

async function containerExec(config: RuntimeConfig, options: ExecOptions): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.runtime, ["exec", ...options.args], {
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = options.timeoutSeconds
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, options.timeoutSeconds * 1_000)
      : undefined;
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout!.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      options.onData?.(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      options.onData?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (options.signal?.aborted) return reject(new Error("aborted"));
      if (timedOut) return reject(new Error(`timeout:${options.timeoutSeconds}`));
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.onData) {
        return reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `container exec exited ${exitCode}`));
      }
      resolve({ code: exitCode, stdout: Buffer.concat(stdout) });
    });

    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

function commandArgs(config: RuntimeConfig, command: string[]): string[] {
  return ["--workdir", config.guestCwd, config.container, ...command];
}

function readOperations(config: RuntimeConfig): ReadOperations {
  return {
    async readFile(filePath) {
      return (await containerExec(config, { args: commandArgs(config, ["cat", "--", guestPath(config, filePath)]) })).stdout;
    },
    async access(filePath) {
      await containerExec(config, { args: commandArgs(config, ["test", "-r", guestPath(config, filePath)]) });
    },
    async detectImageMimeType(filePath) {
      const extension = path.posix.extname(guestPath(config, filePath)).toLowerCase();
      if (extension === ".png") return "image/png";
      if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
      if (extension === ".gif") return "image/gif";
      if (extension === ".webp") return "image/webp";
      return null;
    },
  };
}

function writeOperations(config: RuntimeConfig): WriteOperations {
  return {
    async mkdir(directory) {
      await containerExec(config, { args: commandArgs(config, ["mkdir", "-p", "--", guestPath(config, directory)]) });
    },
    async writeFile(filePath, content) {
      const target = guestPath(config, filePath);
      await containerExec(config, {
        args: ["--interactive", "--workdir", config.guestCwd, config.container, "/bin/sh", "-c", 'cat > "$1"', "sh", target],
        input: content,
      });
    },
  };
}

function editOperations(config: RuntimeConfig): EditOperations {
  const read = readOperations(config);
  const write = writeOperations(config);
  return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function bashOperations(config: RuntimeConfig): BashOperations {
  return {
    async exec(command, cwd, options) {
      const workdir = guestPath(config, cwd);
      const result = await containerExec(config, {
        args: ["--workdir", workdir, config.container, "/bin/sh", "-lc", command],
        signal: options.signal,
        timeoutSeconds: options.timeout,
        onData: options.onData,
      });
      return { exitCode: result.code };
    },
  };
}

export default function containerTools(pi: ExtensionAPI) {
  const config = loadConfig();
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate) {
      return createReadTool(config.guestCwd, { operations: readOperations(config) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      return createWriteTool(config.guestCwd, { operations: writeOperations(config) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      return createEditTool(config.guestCwd, { operations: editOperations(config) }).execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      return createBashTool(config.guestCwd, { operations: bashOperations(config) }).execute(id, params, signal, onUpdate);
    },
  });

  pi.on("before_agent_start", (event) => {
    const hostLine = `Current working directory: ${config.hostCwd}`;
    const guestLine = `Current working directory: ${config.guestCwd} (isolated container workspace)`;
    return {
      systemPrompt: event.systemPrompt.includes(hostLine)
        ? event.systemPrompt.replace(hostLine, guestLine)
        : `${event.systemPrompt}\n\n${guestLine}`,
    };
  });
}
