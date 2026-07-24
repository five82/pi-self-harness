FROM node:22-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends jq ripgrep \
    && rm -rf /var/lib/apt/lists/*
