package spindle

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

type selfHarnessRoundTripFunc func(*http.Request) (*http.Response, error)

func (f selfHarnessRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type selfHarnessCountingBody struct {
	reader *bytes.Reader
	read   int
}

func (body *selfHarnessCountingBody) Read(buffer []byte) (int, error) {
	n, err := body.reader.Read(buffer)
	body.read += n
	return n, err
}

func (*selfHarnessCountingBody) Close() error { return nil }

func selfHarnessClient(t *testing.T, response func() *http.Response) *Client {
	t.Helper()
	client, err := NewClient("http://spindle.invalid")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	client.http = &http.Client{Transport: selfHarnessRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return response(), nil
	})}
	return client
}

func TestSelfHarnessStructuredAPIError(t *testing.T) {
	client := selfHarnessClient(t, func() *http.Response {
		return &http.Response{
			StatusCode: http.StatusUnprocessableEntity,
			Body:       io.NopCloser(strings.NewReader("{\"error\":\"  invalid queue item  \"}")),
			Header:     make(http.Header),
		}
	})

	_, err := client.FetchStatus(context.Background())
	if err == nil {
		t.Fatal("FetchStatus returned nil error")
	}
	message := err.Error()
	if !strings.Contains(message, "status 422") || !strings.Contains(message, "invalid queue item") {
		t.Fatalf("FetchStatus error = %q, want status and structured message", message)
	}
}

func TestSelfHarnessMalformedAPIErrorFallsBackAndIsBounded(t *testing.T) {
	body := &selfHarnessCountingBody{reader: bytes.NewReader(bytes.Repeat([]byte("x"), 1024*1024))}
	client := selfHarnessClient(t, func() *http.Response {
		return &http.Response{StatusCode: http.StatusBadGateway, Body: body, Header: make(http.Header)}
	})

	_, err := client.FetchStatus(context.Background())
	if err == nil || !strings.Contains(err.Error(), "status 502") {
		t.Fatalf("FetchStatus error = %v, want status-only fallback", err)
	}
	if strings.Contains(err.Error(), strings.Repeat("x", 100)) {
		t.Fatalf("FetchStatus leaked malformed body: %q", err)
	}
	if body.read > 64*1024+1 {
		t.Fatalf("error handler read %d bytes, want a bounded read", body.read)
	}
}
