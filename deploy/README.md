# Deploying on the church VPS

Follows the riksunsrk/infra pattern: images from ghcr, shared Traefik for TLS and routing, Prometheus scrape over `traefik-public`. The relay needs no Postgres or S3 (state is files in Docker volumes).

## Images
`.github/workflows/publish-images.yml` publishes on every push to `main` (and `v*` tags):
- `ghcr.io/jsilvanus/web-radio-relay-api` (Node 24 API, `server/Dockerfile`)
- `ghcr.io/jsilvanus/web-radio-relay-nginx` (nginx-rtmp + ffmpeg with config and scripts baked in, `nginx/Dockerfile`)

Tags: `latest`, `sha-<full sha>`, and the version for `v*` tags. Pin `IMAGE_TAG` to a sha in production. If the packages are private, the VPS needs a `read:packages` token to pull.

## Run
`deploy/docker-compose.yml` + `.env` (from `.env.example`). Needs the external network `traefik-public`. Only RTMP (1935) is published on the host; HTTP goes through Traefik to nginx (port 8080), which proxies `/api/` and `/listen` to the API.

## Endpoints added for operations
- `GET /api/health` (no auth): container healthcheck.
- `GET /metrics` (Bearer `METRICS_BEARER_TOKEN`): uptime, per-stream live flag, play and session counters.

## To do before going live (needs Juha)
1. DNS name for `DOMAIN`, and the firewall rule for RTMP 1935 (restrict to the publishers' addresses).
2. Secrets: `RELAY_API_TOKEN`, `METRICS_BEARER_TOKEN` (generate with `openssl rand -hex 32`), kept in the deploy side's secrets, never in this repo.
3. Prometheus: add a job in `riksunsrk/infra` `observability/prometheus/prometheus.yml` (target `web-radio-relay-api:3000`, path `/metrics`, bearer token file) plus `METRICS_TOKEN_WEB_RADIO_RELAY` in infra secrets.
4. Deploy workflow (SSH copy of compose, write `.env`, `docker compose pull && up -d`, wait for healthy) lives on the deploy side like vuorot's `deploy.yml`; add it once the target repo and environment are chosen.
5. `/metrics` is internal only: nginx proxies just `/api/` and `/listen`, so it is not reachable through Traefik.

## Church VPS notes (checked read-only 2026-10-25)
- Traefik: entrypoints 80 (redirects) and 443, resolver `letsencrypt` (TLS challenge, so DNS must point at the VPS before the first certificate), Docker provider on `traefik-public`. It has no TCP entrypoint, so RTMP 1935 is published on the host; 1935 was free. `ufw` is installed but disabled; check for a Hetzner cloud firewall.
- Convention: apps live in `/opt/apps/<app>/docker-compose.yml` with a `.env`, on `traefik-public` (plus `shared_multi_network` if they use Postgres or MinIO), no published ports. The relay uses neither Postgres nor MinIO, so it only joins `traefik-public`.
- Prometheus jobs use `authorization.credentials_file: /tmp/tokens/<app>`, fed from `METRICS_TOKEN_<APP>` in infra's `secrets.enc.yaml`.
- The VPS has 4 GB RAM shared with all apps; memory limits are set in the compose.
