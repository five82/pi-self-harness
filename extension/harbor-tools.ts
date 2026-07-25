import net from "node:net";
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

const TOOL_NAMES = ["read", "bash", "edit", "write"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

interface BridgeConfig {
  socketPath: string;
  guestCwd: string;
  tools: ToolName[];
}

interface RpcResponse {
  type: "data" | "result" | "error";
  data?: string;
  content?: string;
  returnCode?: number;
  message?: string;
}

function loadConfig(): BridgeConfig {
  const encoded = process.env.PI_SELF_HARNESS_HARBOR;
  if (!encoded) throw new Error("PI_SELF_HARNESS_HARBOR is not set");
  const value = JSON.parse(encoded) as Partial<BridgeConfig>;
  if (!value.socketPath || !value.guestCwd || !Array.isArray(value.tools)) {
    throw new Error("PI_SELF_HARNESS_HARBOR is invalid");
  }
  const allowed = new Set<string>(TOOL_NAMES);
  if (value.tools.some((tool) => !allowed.has(tool)) || new Set(value.tools).size !== value.tools.length) {
    throw new Error("PI_SELF_HARNESS_HARBOR contains invalid tools");
  }
  return value as BridgeConfig;
}

async function rpc(
  config: BridgeConfig,
  request: Record<string, unknown>,
  options: { signal?: AbortSignal; onData?: (chunk: Buffer) => void } = {},
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.socketPath);
    let pending = "";
    let settled = false;

    const finish = (error?: Error, response?: RpcResponse) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      socket.end(`${JSON.stringify({ type: "cancel" })}\n`);
      reject(new Error("aborted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line) continue;
        let response: RpcResponse;
        try {
          response = JSON.parse(line) as RpcResponse;
        } catch {
          finish(new Error("Harbor bridge returned invalid JSON"));
          return;
        }
        if (response.type === "data" && response.data) {
          options.onData?.(Buffer.from(response.data, "base64"));
        } else if (response.type === "error") {
          finish(new Error(response.message || "Harbor bridge operation failed"));
          return;
        } else if (response.type === "result") {
          finish(undefined, response);
          return;
        }
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new Error("Harbor bridge closed without a result"));
    });
  });
}

function readOperations(config: BridgeConfig): ReadOperations {
  return {
    async readFile(filePath) {
      const response = await rpc(config, { operation: "read", path: filePath });
      return Buffer.from(response.content || "", "base64");
    },
    async access(filePath) {
      await rpc(config, { operation: "access", path: filePath });
    },
    async detectImageMimeType(filePath) {
      const extension = path.posix.extname(filePath).toLowerCase();
      if (extension === ".png") return "image/png";
      if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
      if (extension === ".gif") return "image/gif";
      if (extension === ".webp") return "image/webp";
      return null;
    },
  };
}

function writeOperations(config: BridgeConfig): WriteOperations {
  return {
    async mkdir(directory) {
      await rpc(config, { operation: "mkdir", path: directory });
    },
    async writeFile(filePath, content) {
      await rpc(config, { operation: "write", path: filePath, content: Buffer.from(content).toString("base64") });
    },
  };
}

function editOperations(config: BridgeConfig): EditOperations {
  const read = readOperations(config);
  const write = writeOperations(config);
  return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function bashOperations(config: BridgeConfig): BashOperations {
  return {
    async exec(command, cwd, options) {
      const response = await rpc(
        config,
        { operation: "exec", command, cwd, timeoutSeconds: options.timeout },
        { signal: options.signal, onData: options.onData },
      );
      return { exitCode: response.returnCode ?? 1 };
    },
  };
}

export default function harborTools(pi: ExtensionAPI) {
  const config = loadConfig();
  const enabled = new Set(config.tools);
  const localCwd = process.cwd();

  if (enabled.has("read")) {
    pi.registerTool({
      ...createReadTool(localCwd),
      async execute(id, params, signal, onUpdate) {
        return createReadTool(config.guestCwd, { operations: readOperations(config) }).execute(id, params, signal, onUpdate);
      },
    });
  }
  if (enabled.has("write")) {
    pi.registerTool({
      ...createWriteTool(localCwd),
      async execute(id, params, signal, onUpdate) {
        return createWriteTool(config.guestCwd, { operations: writeOperations(config) }).execute(id, params, signal, onUpdate);
      },
    });
  }
  if (enabled.has("edit")) {
    pi.registerTool({
      ...createEditTool(localCwd),
      async execute(id, params, signal, onUpdate) {
        return createEditTool(config.guestCwd, { operations: editOperations(config) }).execute(id, params, signal, onUpdate);
      },
    });
  }
  if (enabled.has("bash")) {
    pi.registerTool({
      ...createBashTool(localCwd),
      async execute(id, params, signal, onUpdate) {
        return createBashTool(config.guestCwd, { operations: bashOperations(config) }).execute(id, params, signal, onUpdate);
      },
    });
  }

  pi.on("before_agent_start", (event) => {
    const hostLine = `Current working directory: ${localCwd}`;
    const guestLine = `Current working directory: ${config.guestCwd} (isolated Harbor task container)`;
    return {
      systemPrompt: event.systemPrompt.includes(hostLine)
        ? event.systemPrompt.replace(hostLine, guestLine)
        : `${event.systemPrompt}\n\n${guestLine}`,
    };
  });
}
