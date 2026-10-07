import { httpBase, publicPage } from './public-page';

test('public links follow configured domains without exposing secrets', () => {
  const page = publicPage({ PUBLIC_BASE_URL: 'https://social.example.test', WHATSAPP_PUBLIC_BASE_URL: 'https://wa.example.test', MCP_SSE_AUTH_TOKEN: 'never-show-this' });
  expect(page).toContain('https://social.example.test/mcp');
  expect(page).toContain('href="https://wa.example.test/"');
  expect(page).not.toContain('never-show-this');
  expect(page).not.toContain('e-dani');
});

test('public base rejects credentials and non-web URLs', () => {
  for (const value of ['javascript:alert(1)', 'https://user:pass@example.test', 'https://example.test/?token=secret']) {
    expect(() => httpBase(value, 'TEST')).toThrow();
  }
});
