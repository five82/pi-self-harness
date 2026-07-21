# Tasks

A task replays one historical development request from a fixed revision. It contains the request and verifier, never the eventual solution patch.

```yaml
version: 1
id: pi-extensions-example
repository: pi-extensions
summary: Short human-readable description
baseRevision: HEAD~1
prompt: |
  Implement the requested behavior.
agentTimeoutSeconds: 900
executor:
  type: container
  os: linux
  runtime: podman
  image: node:22-bookworm
  setupNetwork: bridge
  agentNetwork: none
setup:
  command: npm ci
  timeoutSeconds: 600
verification:
  command: npm test && npm run typecheck
  timeoutSeconds: 900
  inject:
    - source: verifiers/pi-extensions-example.test.ts
      destination: test/self-harness-example.test.ts
tags: [typescript, bugfix]
```

Rules:

- Use an immutable commit hash once a task is accepted into a suite.
- Reconstruct the original request without exposing the final patch.
- Prefer hidden verifier assets injected only after the agent run. Sources are relative to the task manifest; destinations must be new files inside the worktree and outside `.git`.
- Never target an active working copy. The runner creates a detached temporary worktree.
- Prefer a Linux container executor. Setup may use network access; the agent defaults to `agentNetwork: none`.
- Use `type: local` only for trusted platform-native tasks such as Xcode builds. Local execution requires an explicit acknowledgement flag.
- Do not include deployment, installation, GUI-launch, production infrastructure, or real encode commands.
- Keep diagnosis, validation, and locked-test assignments outside the task text so the proposer cannot infer them.
