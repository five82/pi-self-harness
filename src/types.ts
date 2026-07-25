export type SupportedOS = "darwin" | "linux";

export type ExecutorType = "local" | "container";
export type ContainerRuntime = "podman" | "docker";
export type ContainerNetwork = "none" | "bridge";

export interface ExecutorRequirement {
  type?: ExecutorType;
  os?: SupportedOS;
  arch?: string;
  requires?: string[];
  runtime?: ContainerRuntime;
  image?: string;
  setupNetwork?: ContainerNetwork;
  agentNetwork?: ContainerNetwork;
}

export interface CommandSpec {
  command: string;
  timeoutSeconds?: number;
}

export interface VerificationAsset {
  source: string;
  destination: string;
}

export interface VerificationSpec extends CommandSpec {
  inject?: VerificationAsset[];
}

export interface RepositorySafety {
  forbiddenCommands?: string[];
  notes?: string[];
}

export interface RepositoryDefinition {
  id: string;
  path: string;
  description?: string;
  defaultVerification?: VerificationSpec;
  executor?: ExecutorRequirement;
  safety?: RepositorySafety;
}

export interface RepositoryConfig {
  version: 1;
  repositories: RepositoryDefinition[];
}

export interface TaskDefinition {
  version: 1;
  id: string;
  repository: string;
  summary: string;
  prompt: string;
  baseRevision: string;
  setup?: CommandSpec;
  verification?: VerificationSpec;
  agentTimeoutSeconds?: number;
  executor?: ExecutorRequirement;
  tags?: string[];
}

export interface EvaluationSuite {
  version: 1;
  id: string;
  description?: string;
  diagnosis: string[];
  validation: string[];
  test: string[];
}

export interface HarnessProfile {
  version: 1;
  id: string;
  description?: string;
  systemPromptAppend?: string;
  tools?: string[];
}

export interface TraceUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
}

export interface TraceSummary {
  turns: number;
  assistantMessages: number;
  toolCalls: number;
  toolErrors: number;
  toolsByName: Record<string, number>;
  toolErrorsByName: Record<string, number>;
  usage: TraceUsage;
  provider?: string;
  model?: string;
  finalStopReason?: string;
  finalText?: string;
}

export interface ProcessResult {
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface ReverificationResult {
  version: 1;
  reverificationId: string;
  originalResultPath: string;
  originalResultSha256: string;
  agentPatchPath: string;
  agentPatchSha256: string;
  taskManifestPath: string;
  taskManifestSha256: string;
  verifierSha256: string;
  taskId: string;
  repositoryId: string;
  sourceRevision: string;
  executor: ExecutorType;
  containerImage?: string;
  containerImageId?: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  failureStage?: "executor" | "setup" | "patch" | "verification";
  error?: string;
  setup?: ProcessResult;
  patchApplication?: ProcessResult;
  verification?: ProcessResult;
  injectedVerificationAssets?: string[];
  worktree?: string;
  containerCleanupError?: string;
  cleanupError?: string;
}

export interface EvaluationResult {
  version: 1;
  runId: string;
  taskId: string;
  repositoryId: string;
  profileId: string;
  model: string;
  thinking?: string;
  piVersion?: string;
  executor: ExecutorType;
  containerImage?: string;
  containerImageId?: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  failureStage?: "executor" | "setup" | "agent" | "verification";
  error?: string;
  worktree?: string;
  sourceRevision: string;
  setup?: ProcessResult;
  agent?: ProcessResult;
  trace?: TraceSummary;
  verification?: ProcessResult;
  injectedVerificationAssets?: string[];
  containerCleanupError?: string;
  cleanupError?: string;
}
