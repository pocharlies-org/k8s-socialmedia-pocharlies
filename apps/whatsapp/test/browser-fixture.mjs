import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

/** Serve the app assets with the same root boundary as the browser fixtures. */
export async function servePublicAsset(request, response, { html } = {}) {
  const pathname = new URL(request.url, 'http://fixture.local').pathname;
  const filename = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!filename.startsWith(`${path.resolve(publicDir)}${path.sep}`)) return response.writeHead(403).end();
  try {
    const body = pathname === '/' && html !== undefined ? html : await readFile(filename);
    response.writeHead(200, { 'content-type': contentTypes[path.extname(filename)] || 'application/octet-stream' }).end(body);
  } catch { response.writeHead(404).end(); }
}

/** Bind an isolated loopback server; callers own its teardown. */
export async function startPublicFixture(options) {
  const server = createServer((request, response) => servePublicAsset(request, response, options));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

/** Keep sidebar DOM/bootstrap shared while each scenario installs its own mocks. */
export function sidebarMenuFixture(initialize, { stylesheet = false } = {}) {
  return `<!doctype html>${stylesheet ? '<link rel="stylesheet" href="/styles.css">' : ''}<button id="opener">Opciones</button><script type="module">
import { installFeatureUI } from '/features-ui.mjs';
(${initialize.toString()})(installFeatureUI);
document.querySelector('#opener').onclick = () => window.ui.openSidebarChatMenu(window.target, document.querySelector('#opener'));
</script>`;
}

/** Create a browser tab with an error collector for Novedades contracts. */
export async function createNovedadesTab(pageErrors) {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/app/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || '/ms-playwright/chromium-1246/chrome-linux64/chrome', args: ['--no-sandbox'] });
  try {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    tab.on('pageerror', error => pageErrors.push(error.message));
    return { browser, tab };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** Collect dimensions in the page context for desktop and mobile assertions. */
export async function viewportMetrics(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
    bodyHeight: document.body.scrollHeight,
  }));
}
