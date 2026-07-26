"""Harbor external agent that keeps Pi and its credentials on the host."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import signal
import subprocess
import tempfile
from typing import Any, override

import yaml
from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_ALLOWED_TOOLS = ("read", "bash", "edit", "write")
_MAX_REQUEST_BYTES = 64 * 1024 * 1024


class PiHostAgent(BaseAgent):
    """Run host Pi while forwarding its four file/shell tools through Harbor."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *,
        thinking: str | None = None,
        append_instructions: str | None = None,
        tools: str = "read,bash,edit,write",
        profile_path: str | None = None,
        pi_path: str | None = None,
        extension_path: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self._thinking = thinking
        self._profile_path = Path(profile_path).resolve() if profile_path else None
        self._profile_sha256: str | None = None
        if self._profile_path:
            if append_instructions is not None or tools != "read,bash,edit,write":
                raise ValueError("profile_path cannot be combined with append_instructions or tools")
            append_instructions, profile_tools = self._load_profile(self._profile_path)
            tools = ",".join(profile_tools)
        self._append_instructions = append_instructions
        self._tools = self._parse_tools(tools)
        self._pi_path = pi_path or shutil.which("pi") or "pi"
        default_extension = Path(__file__).resolve().parents[2] / "extension" / "harbor-tools.ts"
        self._extension_path = Path(extension_path or default_extension).resolve()
        self._version = self._detect_version()
        self._benchmark_provenance_sha256: str | None = None
        self._benchmark_source_revision: str | None = None

    @staticmethod
    @override
    def name() -> str:
        return "pi-host"

    @override
    def version(self) -> str:
        return self._version

    def _load_profile(self, path: Path) -> tuple[str | None, tuple[str, ...]]:
        content = path.read_bytes()
        profile = yaml.safe_load(content)
        if not isinstance(profile, dict) or profile.get("version") != 1:
            raise ValueError(f"invalid harness profile: {path}")
        profile_id = profile.get("id")
        if not isinstance(profile_id, str) or not profile_id.strip():
            raise ValueError("profile id must be a non-empty string")
        allowed = {"version", "id", "description", "systemPromptAppend", "tools"}
        unknown = set(profile) - allowed
        if unknown:
            raise ValueError(f"unsupported profile fields: {sorted(unknown)}")
        description = profile.get("description")
        if description is not None and (not isinstance(description, str) or not description.strip()):
            raise ValueError("profile description must be a non-empty string")
        append = profile.get("systemPromptAppend")
        if append is not None and (not isinstance(append, str) or not append.strip()):
            raise ValueError("systemPromptAppend must be a non-empty string")
        raw_tools = profile.get("tools", list(_ALLOWED_TOOLS))
        if not isinstance(raw_tools, list) or any(not isinstance(tool, str) for tool in raw_tools):
            raise ValueError("profile tools must be a list of strings")
        if len(set(raw_tools)) != len(raw_tools) or any(tool not in _ALLOWED_TOOLS for tool in raw_tools):
            raise ValueError(f"profile tools must be a unique subset of {','.join(_ALLOWED_TOOLS)}")
        tools = tuple(raw_tools)
        self._profile_sha256 = hashlib.sha256(content).hexdigest()
        return append, tools

    @staticmethod
    def _parse_tools(value: str) -> tuple[str, ...]:
        tools = tuple(part.strip() for part in value.split(",") if part.strip())
        if len(set(tools)) != len(tools) or any(tool not in _ALLOWED_TOOLS for tool in tools):
            raise ValueError(f"tools must be a unique subset of {','.join(_ALLOWED_TOOLS)}")
        return tools

    def _detect_version(self) -> str:
        try:
            result = subprocess.run(
                [self._pi_path, "--version"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            return result.stdout.strip().splitlines()[-1].strip()
        except Exception:
            return "unknown"

    @staticmethod
    def _tree_hash(root: Path) -> str:
        digest = hashlib.sha256()
        for path in sorted(item for item in root.rglob("*") if item.is_file()):
            relative = path.relative_to(root).as_posix().encode()
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            content = path.read_bytes()
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
        return digest.hexdigest()

    def _validate_benchmark_provenance(self, environment: BaseEnvironment) -> None:
        task_root = Path(environment.environment_dir).resolve().parent
        provenance_path = task_root.parent / "PROVENANCE.json"
        if not provenance_path.is_file():
            return
        content = provenance_path.read_bytes()
        provenance = json.loads(content)
        config_path = Path(__file__).resolve().parents[2] / "benchmarks" / "terminal-bench-2" / "subset.json"
        expected_config_sha = hashlib.sha256(config_path.read_bytes()).hexdigest()
        if provenance.get("configSha256") != expected_config_sha:
            raise ValueError("Terminal-Bench provenance does not match the trusted subset config")
        task_name = task_root.name
        expected_tree = (provenance.get("materializedTaskSha256") or {}).get(task_name)
        if not isinstance(expected_tree, str) or self._tree_hash(task_root) != expected_tree:
            raise ValueError(f"Terminal-Bench task tree changed after materialization: {task_name}")
        revision = provenance.get("sourceRevision")
        if not isinstance(revision, str) or not revision:
            raise ValueError("Terminal-Bench provenance has no source revision")
        self._benchmark_provenance_sha256 = hashlib.sha256(content).hexdigest()
        self._benchmark_source_revision = revision

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        if not self._extension_path.is_file():
            raise FileNotFoundError(f"Pi Harbor extension not found: {self._extension_path}")
        if shutil.which(self._pi_path) is None and not Path(self._pi_path).is_file():
            raise FileNotFoundError(f"Host Pi executable not found: {self._pi_path}")
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model_name must use provider/model format")
        self._validate_benchmark_provenance(environment)

    async def _send(self, writer: asyncio.StreamWriter, value: dict[str, Any]) -> None:
        writer.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")
        await writer.drain()

    @staticmethod
    def _required_string(request: dict[str, Any], key: str) -> str:
        value = request.get(key)
        if not isinstance(value, str) or "\x00" in value:
            raise ValueError(f"invalid {key}")
        return value

    async def _handle_exec(
        self,
        request: dict[str, Any],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        environment: BaseEnvironment,
    ) -> None:
        command = self._required_string(request, "command")
        cwd = self._required_string(request, "cwd")
        raw_timeout = request.get("timeoutSeconds")
        timeout = int(raw_timeout) if isinstance(raw_timeout, (int, float)) and raw_timeout > 0 else None
        streamed = False

        async def emit(text: str, _stream: Any) -> None:
            nonlocal streamed
            streamed = True
            await self._send(writer, {"type": "data", "data": base64.b64encode(text.encode()).decode()})

        async def execute():
            with environment.scoped_output_callback(emit):
                return await environment.exec(command, cwd=cwd, timeout_sec=timeout)

        exec_task = asyncio.create_task(execute())
        cancel_task = asyncio.create_task(reader.readline())
        done, _ = await asyncio.wait((exec_task, cancel_task), return_when=asyncio.FIRST_COMPLETED)
        if cancel_task in done:
            message = cancel_task.result()
            try:
                cancelled = json.loads(message) if message else {}
            except json.JSONDecodeError:
                cancelled = {}
            if cancelled.get("type") == "cancel":
                exec_task.cancel()
                await asyncio.gather(exec_task, return_exceptions=True)
                raise asyncio.CancelledError
        cancel_task.cancel()
        await asyncio.gather(cancel_task, return_exceptions=True)
        result = await exec_task
        if not streamed:
            for text in (result.stdout, result.stderr):
                if text:
                    await self._send(writer, {"type": "data", "data": base64.b64encode(text.encode()).decode()})
        await self._send(writer, {"type": "result", "returnCode": result.return_code})

    async def _handle_request(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        environment: BaseEnvironment,
        scratch: Path,
    ) -> None:
        try:
            line = await reader.readline()
            if not line:
                return
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            operation = request.get("operation")
            permitted = {
                "read": {"read", "edit"},
                "access": {"read", "edit"},
                "mkdir": {"write"},
                "write": {"write", "edit"},
                "exec": {"bash"},
            }.get(operation, set())
            if not permitted.intersection(self._tools):
                raise PermissionError(f"operation {operation!r} is disabled")

            if operation == "exec":
                await self._handle_exec(request, reader, writer, environment)
                return

            target = self._required_string(request, "path")
            if operation == "access":
                result = await environment.exec(f"test -r -- {shlex.quote(target)}")
                if result.return_code != 0:
                    raise FileNotFoundError(target)
                await self._send(writer, {"type": "result"})
            elif operation == "mkdir":
                result = await environment.exec(f"mkdir -p -- {shlex.quote(target)}")
                if result.return_code != 0:
                    raise RuntimeError(result.stderr or f"mkdir exited {result.return_code}")
                await self._send(writer, {"type": "result"})
            elif operation == "read":
                temporary = scratch / f"read-{secrets.token_hex(8)}"
                await environment.download_file(target, temporary)
                try:
                    content = base64.b64encode(temporary.read_bytes()).decode()
                finally:
                    temporary.unlink(missing_ok=True)
                await self._send(writer, {"type": "result", "content": content})
            elif operation == "write":
                encoded = self._required_string(request, "content")
                try:
                    content = base64.b64decode(encoded, validate=True)
                except ValueError as error:
                    raise ValueError("invalid content") from error
                temporary = scratch / f"write-{secrets.token_hex(8)}"
                container_temporary = f"/tmp/.pi-host-{secrets.token_hex(8)}"
                temporary.write_bytes(content)
                try:
                    await environment.upload_file(temporary, container_temporary)
                    command = f"cat -- {shlex.quote(container_temporary)} > {shlex.quote(target)}; status=$?; rm -f -- {shlex.quote(container_temporary)}; exit $status"
                    result = await environment.exec(command)
                    if result.return_code != 0:
                        raise RuntimeError(result.stderr or f"write exited {result.return_code}")
                finally:
                    temporary.unlink(missing_ok=True)
                await self._send(writer, {"type": "result"})
            else:
                raise ValueError(f"unknown operation {operation!r}")
        except asyncio.CancelledError:
            pass
        except Exception as error:
            try:
                await self._send(writer, {"type": "error", "message": str(error)})
            except (ConnectionError, BrokenPipeError):
                pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, BrokenPipeError):
                pass

    def _pi_args(self, instruction: str) -> list[str]:
        assert self.model_name is not None
        provider, model = self.model_name.split("/", 1)
        args = [
            self._pi_path,
            "--mode", "json",
            "--print",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--no-approve",
            "--no-builtin-tools",
            "--provider", provider,
            "--model", model,
            "--extension", str(self._extension_path),
        ]
        if self._thinking:
            args.extend(("--thinking", self._thinking))
        if self._tools:
            args.extend(("--tools", ",".join(self._tools)))
        if self._append_instructions:
            args.extend(("--append-system-prompt", self._append_instructions))
        args.append(instruction)
        return args

    @staticmethod
    def _populate_usage(path: Path, context: AgentContext) -> tuple[str | None, str | None]:
        totals = {"input": 0, "output": 0, "cacheRead": 0, "cost": 0.0}
        terminal_reason: str | None = None
        terminal_error: str | None = None
        for line in path.read_text(errors="replace").splitlines():
            try:
                event = json.loads(line)
                message = event.get("message") or {}
                if event.get("type") != "message_end" or message.get("role") != "assistant":
                    continue
                terminal_reason = message.get("stopReason")
                terminal_error = message.get("errorMessage")
                usage = message.get("usage") or {}
                totals["input"] += usage.get("input", 0)
                totals["output"] += usage.get("output", 0)
                totals["cacheRead"] += usage.get("cacheRead", 0)
                totals["cost"] += (usage.get("cost") or {}).get("total", 0.0)
            except (json.JSONDecodeError, AttributeError, TypeError):
                continue
        context.n_input_tokens = int(totals["input"] + totals["cacheRead"])
        context.n_cache_tokens = int(totals["cacheRead"])
        context.n_output_tokens = int(totals["output"])
        context.cost_usd = float(totals["cost"]) or None
        return terminal_reason, terminal_error

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        stdout_path = self.logs_dir / "pi.jsonl"
        stderr_path = self.logs_dir / "pi.stderr.log"
        scratch = Path(tempfile.mkdtemp(prefix="pi-host-bridge-", dir="/tmp"))
        scratch.chmod(0o700)
        socket_path = scratch / "bridge.sock"
        guest_cwd = str(environment.task_env_config.workdir or "/app")
        server = await asyncio.start_unix_server(
            lambda reader, writer: self._handle_request(reader, writer, environment, scratch),
            path=socket_path,
            limit=_MAX_REQUEST_BYTES,
        )
        socket_path.chmod(0o600)
        bridge = json.dumps({"socketPath": str(socket_path), "guestCwd": guest_cwd, "tools": self._tools})
        env = os.environ.copy()
        env["PI_SELF_HARNESS_HARBOR"] = bridge
        process: asyncio.subprocess.Process | None = None
        try:
            with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
                process = await asyncio.create_subprocess_exec(
                    *self._pi_args(instruction),
                    cwd=scratch,
                    env=env,
                    stdout=stdout,
                    stderr=stderr,
                    start_new_session=True,
                )
                return_code = await process.wait()
            if return_code != 0:
                tail = stderr_path.read_text(errors="replace")[-4000:]
                raise RuntimeError(f"Host Pi exited {return_code}: {tail}")
            terminal_reason, terminal_error = self._populate_usage(stdout_path, context)
            context.metadata = {
                "pi_version": self._version,
                "extension_sha256": hashlib.sha256(self._extension_path.read_bytes()).hexdigest(),
                "tools": list(self._tools),
                "thinking": self._thinking,
                "profile_path": str(self._profile_path) if self._profile_path else None,
                "profile_sha256": self._profile_sha256,
                "benchmark_provenance_sha256": self._benchmark_provenance_sha256,
                "benchmark_source_revision": self._benchmark_source_revision,
                "terminal_stop_reason": terminal_reason,
            }
            if terminal_reason != "stop":
                detail = terminal_error or f"unexpected terminal stop reason {terminal_reason!r}"
                raise RuntimeError(f"Host Pi did not complete normally: {detail}")
        except asyncio.CancelledError:
            if process and process.returncode is None:
                os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
            raise
        finally:
            server.close()
            await server.wait_closed()
            shutil.rmtree(scratch, ignore_errors=True)
