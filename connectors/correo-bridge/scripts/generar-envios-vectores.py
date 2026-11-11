"""Genera fixtures/envios_vectores.json con el CanalHttp.enviar real de correo-core (main)."""
import asyncio, hashlib, inspect, json, subprocess, sys
import httpx
from correo_core.puertos.mensajeria import CanalHttp
from correo_core.config import Conector

capturas = []
def responder(req: httpx.Request) -> httpx.Response:
    capturas.append(req)
    return httpx.Response(200, json={"ref": "3EB0A1B2C3D4E5F69999", "ts": "2026-10-23T09:06:00Z", "deduplicado": False})

CASOS = [
    ("wa-professional", "whatsapp", "secreto-de-prueba-wa", 1792745100, "34600111222@c.us", "Gracias, ya está en camino. 📦 «ñ»", "resp-41"),
    ("wa-professional", "whatsapp", "secreto-de-prueba-wa", 1792745101, "123456789012345@lid", "Hola", "resp-42.r2"),
    ("tg-professional", "telegram", "secreto-de-prueba-tg", 1792745102, "777000111", "Te lo enviamos mañana.\nUn saludo", "resp:43"),
]

def conector(cid, canal):
    return Conector(id=cid, canal=canal, url="http://puente.conectores.svc:8080", secretFile="/dev/null")

async def main():
    out = []
    for cid, canal, secreto, ts, destino, texto, idem in CASOS:
        c = conector(cid, canal)
        canalhttp = CanalHttp(c, secreto.encode(), reloj=lambda ts=ts: float(ts), transporte=httpx.MockTransport(responder))
        sha = hashlib.sha256(texto.encode()).hexdigest()
        await canalhttp.enviar(destino, texto, sha, idem)
        r = capturas[-1]
        out.append({
            "clave_id": r.headers["x-correo-key-id"], "secreto": secreto, "ts": r.headers["x-correo-timestamp"],
            "metodo": r.method, "objetivo": r.url.raw_path.decode(), "cuerpo": r.content.decode(),
            "firma": r.headers["x-correo-signature"], "texto": texto, "destino_ref": destino, "idempotencia": idem, "sha256": sha,
        })
    rev = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
    print(json.dumps({"fuente": f"correo-core main {rev} correo_core/puertos/mensajeria.py CanalHttp.enviar (DGX-1235 B2): la petición exacta que manda el núcleo, capturada con httpx.MockTransport; secretos inventados", "vectores": out}, ensure_ascii=False, indent=2))

asyncio.run(main())
