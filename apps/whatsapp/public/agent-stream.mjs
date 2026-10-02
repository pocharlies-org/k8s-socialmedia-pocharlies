// Consume the app's sanitized agent events, including frames split across chunks.
export async function readAgentStream(response, onEvent = () => {}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No se pudo abrir la respuesta del agente.');
  const decoder = new TextDecoder();
  let buffer = '';
  let result;
  const frame = source => {
    const lines = source.split('\n');
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === 'error') throw new Error(payload.error || 'El agente no pudo completar la respuesta.');
    if (event === 'result') result = payload;
    onEvent(event, payload);
  };
  try {
    while (result === undefined) {
      const {value, done} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        frame(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (result !== undefined) break;
      }
      if (buffer.length > 1_000_000) throw new Error('La respuesta del agente es demasiado grande.');
      if (done) break;
    }
    if (!result) throw new Error('Se interrumpió la conexión con el agente. La acción no está confirmada.');
    return result;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
