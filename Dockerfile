# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-alpine AS web-builder
WORKDIR /source
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile
COPY apps/web apps/web
RUN bun run --cwd apps/web build

FROM rust:1.97.0-bookworm AS rust-builder
WORKDIR /source
COPY . .
COPY --from=web-builder /source/apps/web/dist apps/web/dist
RUN cargo build --locked --package webrtc-camera-share-server --release --features embed-web

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 camera-share \
    && useradd --uid 10001 --gid camera-share --no-create-home --shell /usr/sbin/nologin camera-share
COPY --from=rust-builder /source/target/release/webrtc-camera-share-server /usr/local/bin/webrtc-camera-share-server
USER 10001:10001
ENV HOST=0.0.0.0 \
    PORT=5011 \
    HEALTHCHECK_HOST=127.0.0.1
EXPOSE 5011
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/webrtc-camera-share-server", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/webrtc-camera-share-server"]
