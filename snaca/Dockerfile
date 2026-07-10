# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.88
ARG DEBIAN_VERSION=bookworm

FROM node:22-${DEBIAN_VERSION} AS web-builder

WORKDIR /src/web

COPY web/package*.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM rust:${RUST_VERSION}-${DEBIAN_VERSION} AS builder

WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        libssl-dev \
        pkg-config \
        protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

COPY . .
COPY --from=web-builder /src/web/dist ./web/dist

RUN cargo build --release -p snaca-server -p snaca-plugin-lark -p snaca-cli

FROM debian:${DEBIAN_VERSION}-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        libssl3 \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --create-home --home-dir /home/snaca snaca \
    && mkdir -p /app/bin /config /data \
    && chown -R snaca:snaca /app /config /data

COPY --from=builder /src/target/release/snaca-server /app/bin/snaca-server
COPY --from=builder /src/target/release/snaca-plugin-lark /app/bin/snaca-plugin-lark
COPY --from=builder /src/target/release/snaca-cli /app/bin/snaca-cli
COPY --from=builder /src/snaca.toml.example /app/snaca.toml.example
COPY --from=builder /src/docs /app/docs
COPY --from=builder /src/examples /app/examples
COPY --from=builder /src/README.md /app/README.md
COPY --from=builder /src/LICENSE /app/LICENSE
COPY docker/snaca.toml /config/snaca.toml

RUN chown -R snaca:snaca /app /config /data

USER snaca

ENV SNACA_DIR=/app \
    RUST_LOG=info \
    SNACA_APPROVAL_MODE=allow \
    SNACA_BASH_RELAXED=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/app/bin/snaca-server"]
CMD ["--config", "/config/snaca.toml"]
