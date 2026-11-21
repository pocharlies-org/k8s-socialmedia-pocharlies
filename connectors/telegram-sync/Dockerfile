# INFRA-1500 (INFRA-540 P2) — base comun del dominio fijada por digest: base-python-slim-uv:3.12
# (docs/images/bases.md de k8s-infra-pocharlies). El host es el registry al que ya
# autentican los workflows de este repo (harbor.lan.e-dani.com); el digest es el
# canonico de bases.md (la misma imagen que harbor.e-dani.com).
FROM harbor.lan.e-dani.com/homelab/base-python-slim-uv:3.12@sha256:e2b290bdd0bdf118dd3daa355aa6019faa1d2c8301b818ef46dc653bd9fd9e20

# Debian security updates. The release pipeline refuses any image that still
# carries a fixable HIGH/CRITICAL finding.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY connectors/telegram-sync/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY connectors/telegram-sync/sync/ sync/
COPY connectors/telegram-sync/run_sync.py .

CMD ["python", "run_sync.py"]
