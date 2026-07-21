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

export interface EvaluationResult {
  version: 1;
  runId: string;
  taskId: string;
  repositoryId: string;
  profileId: string;
  model: string;
  thinking?: string;
  executor: ExecutorType;
  containerImage?: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  failureStage?: "executor" | "setup" | "agent" | "verification";
  error?: string;
  worktree?: string;
  sourceRevision: string;
  setup?: ProcessResult;
  agent?: ProcessResult;
  verification?: ProcessResult;
  injectedVerificationAssets?: string[];
  containerCleanupError?: string;
  cleanupError?: string;
}
