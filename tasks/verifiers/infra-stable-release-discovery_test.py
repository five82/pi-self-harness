import json
from types import SimpleNamespace

import pytest

from infra_shared import releases


def fact_output(monkeypatch, output, raw_output=None):
    calls = []

    def get_fact(*args, **kwargs):
        calls.append((args, kwargs))
        command = args[1]
        return raw_output if raw_output is not None and "python3 -c" not in command else output

    monkeypatch.setattr(releases, "host", SimpleNamespace(get_fact=get_fact))
    return calls


def test_self_harness_latest_github_tag_uses_stable_release_endpoint(monkeypatch):
    calls = fact_output(
        monkeypatch,
        "v1.2.3\n",
        json.dumps({"tag_name": "v1.2.3", "prerelease": False, "draft": False}),
    )
    assert releases.latest_github_tag("owner/tool") == "v1.2.3"
    command = calls[0][0][1]
    assert "api.github.com/repos/owner/tool/releases/latest" in command


@pytest.mark.parametrize("output", ["", "v1.2.3 beta", "$(touch /tmp/bad)"])
def test_self_harness_latest_github_tag_rejects_untrusted_output(monkeypatch, output):
    fact_output(
        monkeypatch,
        output,
        json.dumps({"tag_name": output, "prerelease": False, "draft": False}),
    )
    with pytest.raises(RuntimeError):
        releases.latest_github_tag("owner/tool")


def test_self_harness_latest_npm_version_validates_registry_output(monkeypatch):
    fact_output(monkeypatch, "12.3.1\n", json.dumps({"version": "12.3.1"}))
    assert releases.latest_npm_version() == "12.3.1"

    fact_output(monkeypatch, "latest", json.dumps({"version": "latest"}))
    with pytest.raises(RuntimeError):
        releases.latest_npm_version()


def go_metadata(filename, sha256, architecture="arm64"):
    return json.dumps(
        [
            {
                "version": "go1.26.6",
                "stable": True,
                "files": [
                    {
                        "filename": filename,
                        "os": "linux",
                        "arch": architecture,
                        "version": "go1.26.6",
                        "sha256": sha256,
                        "kind": "archive",
                    }
                ],
            }
        ]
    )


def test_self_harness_latest_go_download_selects_verified_linux_archive(monkeypatch):
    sha256 = "ab" * 32
    filename = "go1.26.6.linux-arm64.tar.gz"
    calls = fact_output(
        monkeypatch,
        f"go1.26.6 {filename} {sha256}\n",
        go_metadata(filename, sha256),
    )
    assert releases.latest_go_download("arm64") == ("1.26.6", filename, sha256)
    assert "go.dev/dl/?mode=json" in calls[0][0][1]


@pytest.mark.parametrize(
    "output",
    [
        "go1.26.6 go1.26.6.linux-amd64.tar.gz " + "ab" * 32,
        "go1.26.6 go1.26.6.linux-arm64.zip " + "ab" * 32,
        "go1.26.6 go1.26.6.linux-arm64.tar.gz not-a-sha",
    ],
)
def test_self_harness_latest_go_download_rejects_malformed_metadata(monkeypatch, output):
    _, filename, sha256 = output.split()
    architecture = "amd64" if "linux-amd64" in filename else "arm64"
    fact_output(monkeypatch, output, go_metadata(filename, sha256, architecture))
    with pytest.raises(RuntimeError):
        releases.latest_go_download("arm64")


def test_self_harness_latest_go_download_rejects_unsupported_architecture():
    with pytest.raises(ValueError):
        releases.latest_go_download("386")
