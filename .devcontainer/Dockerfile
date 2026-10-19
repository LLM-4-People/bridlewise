FROM mcr.microsoft.com/devcontainers/typescript-node:5-24-trixie@sha256:91dc841966e9b47195a1a6290a8ef9bba5ba43c02aa22f87f8669c16bb6f0f6e

# The guardian and its process supervisor are C. Keep the image able to build
# and test them so a Codespace can run the same gate as CI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
