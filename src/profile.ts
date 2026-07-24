export const ALLOWED_PROFILE_TOOLS = ["read", "bash", "edit", "write"] as const;

export function assertAllowedProfileTools(tools: string[] | undefined, context: string): void {
  if (!tools) return;
  const allowed = new Set<string>(ALLOWED_PROFILE_TOOLS);
  for (const tool of tools) {
    if (!allowed.has(tool)) throw new Error(`${context}: unsupported tool ${JSON.stringify(tool)}`);
  }
  if (new Set(tools).size !== tools.length) throw new Error(`${context}: duplicate tool names`);
}
