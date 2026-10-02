export function httpBase(value: string, name: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment`);
  }
  return url.toString().replace(/\/$/, '');
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
}

export function publicPage(env: NodeJS.ProcessEnv = process.env): string {
  const base = httpBase(
    env.PUBLIC_BASE_URL || `http://localhost:${env.MCP_SSE_PORT || '3010'}`,
    'PUBLIC_BASE_URL'
  );
  const whatsapp = env.WHATSAPP_PUBLIC_BASE_URL
    ? httpBase(env.WHATSAPP_PUBLIC_BASE_URL, 'WHATSAPP_PUBLIC_BASE_URL')
    : '';
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Socialmedia</title><style>
:root{color-scheme:light;--ink:#173831;--paper:#f2efdf;--accent:#cf532d}*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top right,#d5e6d2,transparent 60%),var(--paper);color:var(--ink);font:18px/1.6 Georgia,serif;padding:clamp(24px,7vw,100px)}
main{max-width:760px}h1{font-size:clamp(48px,10vw,96px);line-height:1;margin:30px 0}p{max-width:620px}a{color:var(--ink)}.action{display:inline-block;padding:12px 22px;background:var(--ink);color:var(--paper);border-radius:5px;text-decoration:none;margin:20px 0}code{font:15px/1.6 monospace;overflow-wrap:anywhere}small{color:var(--accent)}
</style><main><small>SOCIALMEDIA / TU ESPACIO</small><h1>Tus cuentas,<br>en un lugar.</h1>
<p>Gestiona la vinculacion de WhatsApp desde el acceso a cuentas. Se solicitara tu usuario y contrasena.</p>
${whatsapp ? `<a class="action" href="${escapeHtml(whatsapp)}/">Abrir cuentas WhatsApp</a>` : '<p>Configura WHATSAPP_PUBLIC_BASE_URL para mostrar el acceso a cuentas.</p>'}
<p>La conexion para asistentes esta disponible en <code>${escapeHtml(base)}/mcp</code>. Este acceso requiere un token y se utiliza desde un cliente MCP, como LiteLLM.</p>
<p>Instagram se conecta mediante las credenciales de Meta configuradas en el servidor.</p></main></html>`;
}
