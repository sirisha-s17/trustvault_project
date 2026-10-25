# TrustVault frontend

Standalone HTML, CSS, and JavaScript frontend. No frontend framework or
third-party runtime dependencies are required.

## Configure the API URL

Edit `config.js` and set `apiBaseUrl` to the backend's API root, including
`/api`, for example:

```js
window.TRUSTVAULT_CONFIG = Object.freeze({
  apiBaseUrl: "https://api.example.com/api"
});
```

By default it uses the page's own origin (`/api`), or `http://localhost:3000/api` when served by the dev server on port 5173.
`app.js` sends session cookies with credentialed requests; do not use `*` CORS
origins or place secrets in this file.

## Run locally

Start MongoDB and the backend on port 3000. Then in another terminal:

```powershell
Set-Location .\frontend
npm start
```

Open `http://localhost:5173`. Set backend `CLIENT_ORIGIN` to
`http://localhost:5173`; the API only accepts browser requests from that exact
origin. If serving this directory directly from Express instead, set the
origin to the Express UI origin and point `apiBaseUrl` to its `/api`.

In production, deploy this folder as static files over HTTPS, configure
`apiBaseUrl` to the HTTPS backend `/api` URL, and set the backend
`CLIENT_ORIGIN` to the exact frontend origin. Cross-origin cookies require
HTTPS and the backend enables credentialed CORS only for that configured
origin.
