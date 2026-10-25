window.TRUSTVAULT_CONFIG = Object.freeze({
  // Same-origin by default (backend serves this folder). The standalone dev
  // server on :5173 talks to the local API on :3000. For a separately hosted
  // frontend, replace with the deployed API origin plus /api, e.g. https://api.example.com/api.
  apiBaseUrl: window.location.port === "5173"
    ? "http://localhost:3000/api"
    : `${window.location.origin}/api`
});
