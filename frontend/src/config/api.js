/**
 * Universal API Base URL configuration.
 * - In production on Cloudflare Pages: API_BASE is "" (same origin /api/*).
 * - In local development: Vite proxies /api to http://localhost:5000 automatically,
 *   or honors VITE_API_URL if explicitly specified.
 */
export const API_BASE = (
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  (typeof globalThis !== "undefined" && globalThis.process?.env?.VITE_API_URL) ||
  ""
).replace(/\/$/, "");

export const API_ROUTES = {
  health: `${API_BASE}/api/health`,
  identify: `${API_BASE}/api/identify`,
  lookupStructure: `${API_BASE}/api/lookup-structure`,
  analyze: `${API_BASE}/api/analyze`,
  explainStructure: `${API_BASE}/api/explain-structure`,
  generateStructure: `${API_BASE}/api/generate-structure`,
  chat: `${API_BASE}/api/chat`,
  compounds: `${API_BASE}/api/compounds`,
  history: `${API_BASE}/api/history`,
};
