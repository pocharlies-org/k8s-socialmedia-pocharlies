export function createUiPath(basePath = process.env.UI_BASE_PATH || ''): (path: string) => string {
  // Restrict segments so the prefix is safe in HTML attributes and inline scripts.
  if (basePath && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(basePath)) {
    throw new Error('UI_BASE_PATH must be empty or an absolute path of safe URL segments');
  }
  const prefix = basePath.replace(/\/$/, '');
  return (path: string): string => `${prefix}${path}`;
}
