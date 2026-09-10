# syntax=docker/dockerfile:1
# Single-image deploy: build the React frontend, then serve it + the FastAPI API
# + the baked DuckDB file from one Python process. Targets Cloud Run / any
# container host. Build from the repo root: `docker build -t nfldb .`

# ---- Stage 1: build the frontend ----
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY frontend/ ./
RUN npm run build            # -> /app/frontend/dist

# ---- Stage 2: backend + static frontend + database ----
FROM python:3.12-slim
WORKDIR /app/api
COPY api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# backend source + the baked DuckDB file (api/data/nfl.duckdb)
COPY api/ ./
# the built frontend, served by FastAPI at / (see main.py)
COPY --from=frontend /app/frontend/dist ./static

# Cloud Run provides $PORT (8080); single worker (DuckDB is single-writer).
ENV PORT=8080
# Keep DuckDB inside the container's limits: it sizes its memory budget and
# thread pool from the HOST, not the cgroup, so an unpinned build sizes itself
# for the machine and gets the instance OOM-killed. Sized against the deploy's
# --memory 4Gi --cpu 2, leaving ~1.6Gi for Python and the app. Keep both values
# in step with deploy.yml whenever the service's resources change.
ENV DUCKDB_MEMORY_LIMIT=2400MB
ENV DUCKDB_THREADS=2
EXPOSE 8080
# --proxy-headers + trust all forwarded IPs: on Cloud Run only Google's front
# end can reach the container, and it sets X-Forwarded-For to the real client.
# Without this, request.client.host is the proxy IP and per-IP rate limits
# collapse every user into one bucket.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
