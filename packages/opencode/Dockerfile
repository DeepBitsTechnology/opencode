FROM debian:12-slim AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apt-get update && apt-get install -y ripgrep libgcc-s1 && rm -rf /var/lib/apt/lists/*

COPY dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
RUN opencode --version
ENTRYPOINT ["opencode"]
