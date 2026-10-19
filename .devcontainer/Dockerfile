FROM mcr.microsoft.com/devcontainers/typescript-node:5-24-trixie

# The guardian and its process supervisor are C. Keep the image able to build
# and test them so a Codespace can run the same gate as CI.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
