FROM golang:1.26-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends jq ripgrep \
    && ln -s /usr/local/go/bin/go /usr/local/bin/go \
    && ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt \
    && rm -rf /var/lib/apt/lists/*
