#!/bin/sh
set -eu

source_file="internal/encode/adaptive.go"
test_file="internal/encode/self_harness_memory_pressure_test.go"
trap 'rm -f "$test_file"' EXIT

if grep -Eq 'hasPressure\([^,()]+ float64\) bool' "$source_file"; then
  high_call='l.hasPressure(0.75)'
  boundary_call='l.hasPressure(memoryPressureAvailableFraction)'
  low_call='l.hasPressure(0.15)'
elif grep -Eq 'hasPressure\([^,()]+ float64, [^,()]+ uint64\) bool' "$source_file"; then
  high_call='l.hasPressure(0.75, swapPressureGrowthBytes)'
  boundary_call='l.hasPressure(memoryPressureAvailableFraction, swapPressureGrowthBytes)'
  low_call='l.hasPressure(0.15, 0)'
else
  echo "unsupported adaptiveLimiter.hasPressure signature" >&2
  exit 1
fi

cat >"$test_file" <<EOF
package encode

import "testing"

func TestSelfHarnessSwapGrowthAloneDoesNotReduceWorkers(t *testing.T) {
	l := &adaptiveLimiter{}
	if $high_call {
		t.Fatal("swap growth with 75% available memory must not be pressure")
	}
	if $boundary_call {
		t.Fatal("the exact available-memory boundary must not be pressure")
	}
	if !$low_call {
		t.Fatal("15% available memory must remain pressure without swap growth")
	}
}

func TestSelfHarnessSwapGrowthOnlyEscalatesLowMemoryReduction(t *testing.T) {
	withoutSwap := newAdaptiveLimiter(8, 6, 8, 0, nil, nil)
	withoutSwap.reduceTarget(0.15, 0)
	_, withoutSwapTarget, _ := withoutSwap.stats()

	withSwap := newAdaptiveLimiter(8, 6, 8, 0, nil, nil)
	withSwap.reduceTarget(0.15, swapPressureGrowthBytes)
	_, withSwapTarget, _ := withSwap.stats()

	if withoutSwapTarget != 4 {
		t.Fatalf("ordinary low-memory target = %d, want 4", withoutSwapTarget)
	}
	if withSwapTarget != 3 {
		t.Fatalf("low-memory target with swap growth = %d, want 3", withSwapTarget)
	}
}
EOF

go test "$source_file" "$test_file"
