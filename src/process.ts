import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.ts";

const TAIL_BYTES = 64 * 1024;

function appendTail(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next, "utf8") <= TAIL_BYTES ? next : next.slice(-TAIL_BYTES);
}

export interface RunProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  captureTail?: boolean;
}

async function outputStream(path: string | undefined) {
  if (!path) return undefined;
  await mkdir(dirname(path), { recursive: true });
  return createWriteStream(path, { flags: "w", mode: 0o600 });
}

export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const args = options.args ?? [];
  const started = Date.now();
  const stdoutFile = await outputStream(options.stdoutPath);
  const stderrFile = await outputStream(options.stderrPath);

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutTail = "";
    let stderrTail = "";
    let timedOut = false;
    let settled = false;

    const finishStreams = () => {
      stdoutFile?.end();
      stderrFile?.end();
    };

    const killTree = () => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        // The process may already have exited.
      }
      setTimeout(() => {
        if (settled || !child.pid) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process may already have exited.
        }
      }, 5_000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.captureTail !== false) stdoutTail = appendTail(stdoutTail, chunk);
      stdoutFile?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (options.captureTail !== false) stderrTail = appendTail(stderrTail, chunk);
      stderrFile?.write(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finishStreams();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finishStreams();
      resolve({
        command: options.command,
        args,
        code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        stdoutTail,
        stderrTail,
      });
    });
  });
}

export async function runShell(
  command: string,
  options: Omit<RunProcessOptions, "command" | "args">,
): Promise<ProcessResult> {
  return runProcess({ ...options, command: "/bin/bash", args: ["-lc", command] });
}
