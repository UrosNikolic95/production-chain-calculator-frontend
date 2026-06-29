// Production environment (default — used by `ng build`).
// Relative path so the browser hits the same origin; nginx proxies /api to the backend.
export const environment = {
  production: true,
  apiBase: '/api',
};
