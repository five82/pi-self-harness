package encoder

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func selfHarnessIVF(t *testing.T, fpsNum, fpsDen uint32, frames ...struct {
	pts  int64
	size int
}) []byte {
	t.Helper()
	var output bytes.Buffer
	if err := writeIVFHeader(&output, 64, 64, fpsNum, fpsDen); err != nil {
		t.Fatalf("writeIVFHeader: %v", err)
	}
	for _, frame := range frames {
		if err := writeIVFFrame(&output, bytes.Repeat([]byte{0x5a}, frame.size), frame.pts); err != nil {
			t.Fatalf("writeIVFFrame: %v", err)
		}
	}
	return output.Bytes()
}

func TestSelfHarnessPeakSecondBpsBucketsPayloads(t *testing.T) {
	frames := []struct {
		pts  int64
		size int
	}{
		{pts: 0, size: 100},
		{pts: 1, size: 200},
		{pts: 2, size: 400},
		{pts: 3, size: 500},
	}
	peak, err := PeakSecondBps(bytes.NewReader(selfHarnessIVF(t, 2, 1, frames...)), 2, 1)
	if err != nil {
		t.Fatalf("PeakSecondBps: %v", err)
	}
	if want := float64((400 + 500) * 8); peak != want {
		t.Fatalf("PeakSecondBps = %v, want %v", peak, want)
	}
}

func TestSelfHarnessPeakSecondBpsUsesRationalPTSAndHandlesEmpty(t *testing.T) {
	frames := []struct {
		pts  int64
		size int
	}{
		{pts: 24, size: 700},
		{pts: 0, size: 100},
		{pts: 23, size: 300},
	}
	peak, err := PeakSecondBps(bytes.NewReader(selfHarnessIVF(t, 24_000, 1_001, frames...)), 24_000, 1_001)
	if err != nil {
		t.Fatalf("PeakSecondBps: %v", err)
	}
	if want := float64(700 * 8); peak != want {
		t.Fatalf("fractional-rate peak = %v, want %v", peak, want)
	}

	empty, err := PeakSecondBps(bytes.NewReader(selfHarnessIVF(t, 24, 1)), 24, 1)
	if err != nil || empty != 0 {
		t.Fatalf("empty IVF = (%v, %v), want (0, nil)", empty, err)
	}
}

func TestSelfHarnessPeakSecondBpsRejectsInvalidAndTruncatedInput(t *testing.T) {
	validHeader := selfHarnessIVF(t, 24, 1)
	for _, rate := range [][2]uint32{{0, 1}, {24, 0}} {
		if _, err := PeakSecondBps(bytes.NewReader(validHeader), rate[0], rate[1]); err == nil {
			t.Fatalf("PeakSecondBps accepted frame rate %d/%d", rate[0], rate[1])
		}
	}
	if _, err := PeakSecondBps(bytes.NewReader(validHeader[:31]), 24, 1); err == nil {
		t.Fatal("PeakSecondBps accepted a truncated IVF header")
	}
	if _, err := PeakSecondBps(bytes.NewReader(append(validHeader, 0x01)), 24, 1); err == nil {
		t.Fatal("PeakSecondBps accepted a truncated frame header")
	}

	var truncated bytes.Buffer
	truncated.Write(validHeader)
	var frameHeader [12]byte
	binary.LittleEndian.PutUint32(frameHeader[:4], 10)
	truncated.Write(frameHeader[:])
	truncated.Write([]byte{1, 2, 3})
	if _, err := PeakSecondBps(bytes.NewReader(truncated.Bytes()), 24, 1); err == nil {
		t.Fatal("PeakSecondBps accepted a truncated frame payload")
	}
}
