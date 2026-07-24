package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSelfHarnessLoadsNestedSpindleAPIConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	path := filepath.Join(home, "config.toml")
	contents := "[api]\nbind = \" 127.0.0.1:8747 \"\ntoken = \" local-secret \"\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIBind != "127.0.0.1:8747" {
		t.Fatalf("APIBind = %q", cfg.APIBind)
	}
	if cfg.APIToken != "local-secret" {
		t.Fatalf("APIToken = %q", cfg.APIToken)
	}
}

func TestSelfHarnessMissingConfigDoesNotInventAPIListener(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.toml"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIBind != "" || cfg.APIToken != "" {
		t.Fatalf("API config = bind:%q token:%q, want empty", cfg.APIBind, cfg.APIToken)
	}
}
