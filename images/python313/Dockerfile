FROM python:3.13-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends jq ripgrep \
    && pip install --no-cache-dir uv==0.11.30 \
    && rm -rf /var/lib/apt/lists/*
