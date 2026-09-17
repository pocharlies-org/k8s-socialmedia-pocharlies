FROM harbor.lan.e-dani.com/cache/library/python:3.12-slim

# Debian security updates. The release pipeline refuses any image that still
# carries a fixable HIGH/CRITICAL finding.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY connectors/telegram-sync/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY connectors/telegram-sync/sync/ sync/
COPY connectors/telegram-sync/run_sync.py .

CMD ["python", "run_sync.py"]
