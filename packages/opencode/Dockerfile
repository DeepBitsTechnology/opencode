FROM node:20-slim AS libsql-native
WORKDIR /libsql
RUN npm install @libsql/linux-x64-gnu@0.5.22

FROM debian:12-slim AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apt-get update && apt-get install -y ripgrep libgcc-s1 ca-certificates && rm -rf /var/lib/apt/lists/*

COPY dist/opencode-linux-x64/bin/opencode /usr/local/bin/opencode
COPY --from=libsql-native /libsql/node_modules/@libsql/linux-x64-gnu /node_modules/@libsql/linux-x64-gnu
ENV NODE_PATH=/node_modules
RUN opencode --version
ENTRYPOINT ["opencode"]
