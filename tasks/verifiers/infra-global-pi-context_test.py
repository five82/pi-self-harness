import importlib
import inspect
import re
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
EXPECTED = "Be extremely concise. Sacrifice grammer for the sake of concision.\n"
HOSTS = ("red", "blue", "white", "gunmetal")


def discover_operation_name():
    names = []
    for host in HOSTS:
        deploy = (ROOT / f"pyinfra/{host}/deploy.py").read_text()
        start = deploy.index("pi_coding_agent.deploy(")
        end = deploy.index("pi_extensions.deploy(")
        between = deploy[start:end]
        candidates = [name for name in re.findall(r"^([a-zA-Z_]\w*)\.deploy\(", between, re.MULTILINE)
                      if name != "pi_coding_agent"]
        assert len(candidates) == 1, f"{host} must wire one dedicated Pi context operation"
        names.append(candidates[0])
    assert len(set(names)) == 1, f"hosts use different Pi context operations: {names}"
    return names[0]


def load_operation():
    return importlib.import_module(f"infra_shared.operations.{discover_operation_name()}")


def capture_operations(monkeypatch, operation):
    calls = []
    monkeypatch.setattr(operation.files, "directory", lambda **kwargs: calls.append(("directory", kwargs)))
    monkeypatch.setattr(operation.files, "put", lambda **kwargs: calls.append(("put", kwargs)))
    if hasattr(operation, "host"):
        monkeypatch.setattr(operation, "host", SimpleNamespace(get_fact=lambda *args, **kwargs: "/Users/current"))
    if hasattr(operation, "text"):
        monkeypatch.setattr(operation, "text", lambda *args, **kwargs: "/Users/current")
    return calls


def invoke_linux(operation):
    parameters = inspect.signature(operation.deploy).parameters
    if "home" in parameters:
        kwargs = {"home": "/home/alice"}
        if "owner" in parameters:
            kwargs["owner"] = "alice"
        if "user" in parameters:
            kwargs["user"] = "alice"
        if "group" in parameters:
            kwargs["group"] = "alice"
        operation.deploy(**kwargs)
    else:
        operation.deploy(SimpleNamespace(name="alice", home="/home/alice"))


def invoke_current_user(operation):
    parameters = inspect.signature(operation.deploy).parameters
    if "home" in parameters:
        operation.deploy(home="/Users/current")
    else:
        operation.deploy()


def test_self_harness_shared_resource_and_linux_ownership(monkeypatch):
    operation = load_operation()
    calls = capture_operations(monkeypatch, operation)
    invoke_linux(operation)
    directory = next(kwargs for kind, kwargs in calls if kind == "directory")
    installed = next(kwargs for kind, kwargs in calls if kind == "put")

    assert directory["path"] == "/home/alice/.pi/agent"
    assert directory["mode"] == "0755"
    assert directory["_sudo"] is False
    assert directory["user"] == "alice" and directory["group"] == "alice"
    assert installed["dest"] == "/home/alice/.pi/agent/AGENTS.md"
    assert installed["mode"] == "0644"
    assert installed["_sudo"] is False
    assert installed["user"] == "alice" and installed["group"] == "alice"
    resource = Path(installed["src"]).resolve()
    assert resource.is_relative_to((ROOT / "pyinfra/infra_shared/files").resolve())
    assert resource.read_text() == EXPECTED


def test_self_harness_current_user_does_not_force_ownership(monkeypatch):
    operation = load_operation()
    calls = capture_operations(monkeypatch, operation)
    invoke_current_user(operation)
    for _, kwargs in calls:
        assert kwargs.get("path", kwargs.get("dest", "")).startswith("/Users/current/.pi/agent")
        assert "user" not in kwargs and "group" not in kwargs
        assert kwargs["_sudo"] is False


def test_self_harness_every_host_wires_one_shared_operation_in_order():
    assert discover_operation_name()
