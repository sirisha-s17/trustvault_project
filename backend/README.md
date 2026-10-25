# TrustVault backend

TrustVault is a Node.js/Express API using MongoDB and private local file storage.
The service implements authentication, per-document grants, server-side access
checks, file validation, search, audit recording, and administrative APIs.

## Requirements and setup

- Node.js 20 or later
- MongoDB Atlas or another MongoDB replica set (the audit sequence index is
  created during startup)

Install dependencies and configure environment variables:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set `MONGODB_URI`, `JWT_SECRET` (at least 32 characters), and `CLIENT_ORIGIN`.
When deployed behind a reverse proxy or platform load balancer (Render,
Railway, Heroku, Nginx), set `TRUST_PROXY=1`; otherwise every client shares the
proxy's IP and the login rate limit locks everyone out after 10 failures.
Set `STORAGE_DIR` to a private writable directory that is not publicly served
and is shared by every API instance. The default `private-storage` directory is
local to the backend process and is suitable only for a single-host deployment.
Set secrets via a deployment secret manager or local environment when possible;
never commit `.env`. This workspace is inside OneDrive, so do not save database
credentials in a synchronized `.env` file.

### Demo data (one account per role)

```powershell
npm run seed
npm start          # UI and API both on http://localhost:$PORT
```

`npm run seed` is idempotent. It creates these accounts and eight sample
documents (HR letters, contracts, drawings, audit papers) with grants, two
time-limited partner grants, a document with two versions, and one item in
trash:

| Role | Email | Password | What to try |
| --- | --- | --- | --- |
| Admin | `admin@trustvault.demo` | `Admin@Vault2026!` | Overview alerts, activity log, verify chain; cannot open any document |
| Owner | `olivia.owner@trustvault.demo` | `Owner@Vault2026!` | HR documents, sharing, suggestions, trash/restore |
| Owner | `marcus.owner@trustvault.demo` | `Owner2@Vault2026!` | Legal documents; has an *edit* grant on Olivia's handbook |
| Viewer | `victor.viewer@trustvault.demo` | `Viewer@Vault2026!` | Sees only his salary letter and the handbook |
| Viewer | `priya.viewer@trustvault.demo` | `Viewer2@Vault2026!` | External partner; two grants that expire in 7 and 14 days |

These are public demo credentials. Change them (or re-create the users) for
any deployment holding real data.

### Creating individual users

Provision an administrator with environment variables, then start:

```powershell
$env:USER_NAME = "TrustVault Admin"
$env:USER_EMAIL = "admin@example.com"
$env:USER_PASSWORD = "use-a-unique-password-of-at-least-12-characters"
$env:USER_ROLE = "admin"
npm run create:user
npm start
```

Provision owner and viewer accounts the same way, changing `USER_ROLE`. There
is no public registration endpoint. Admins can create additional accounts via
the API. Use `npm run dev` for local watch mode and `npm test` for tests.

`GET /api/health` reports API liveness; startup fails if MongoDB is unavailable.
All state-changing HTTP requests require an exact `Origin` matching
`CLIENT_ORIGIN`. Credentialed CORS responses are sent only to that origin. The
login cookie is HTTP-only and Secure in production; production cross-origin
frontend deployments require HTTPS.

## Permission model

- **Admin:** User administration, ownership transfer, and audit viewing. Admin
  status does not grant access to document contents.
- **Owner:** Uploads documents, can read/edit/delete their own documents, and
  can grant or revoke access on each individual document.
- **Viewer:** Can read a document only with an explicit `read` grant.
- **Read grant:** Open details, download any version.
- **Edit grant:** Read, plus rename/recategorise and upload new versions. Not
  deletion, restore, sharing, or seeing the access list/history.
- **Grant expiry (optional):** Access ends automatically at `expiresAt`, for
  external partners. Expired grants are kept for the record but match nothing.

Every document request re-reads the document and its current grant from
MongoDB through one helper (`src/services/access.service.js`), which is also
what builds the search query. Revocation therefore blocks the next API request;
the API issues no signed or public download links. Deactivating a user removes
their document grants, invalidates their tokens, and requires transferring
their owned documents first (People → Transfer documents).

**Access suggestions.** In a document's Access tab the owner can ask for
suggestions. The server ranks people who already hold grants on the owner's
*other* documents (same category weighs more). It is a transparent heuristic,
not an LLM. It never grants anything: the owner confirms, and both the
suggestion (`access_suggestion`) and the decision (`permission_grant` with
`source: "suggestion"`) are audited.

**Deletion and recovery.** Delete is a soft delete into the owner's Trash;
nobody, including the owner, can reach it until it is restored. Every file
version is kept. There is no automatic purge or retention schedule yet.

## File handling

Uploads are limited by `MAX_UPLOAD_BYTES` (25 MiB by default) and a small
signature-checked allowlist: PDF, PNG, JPEG, and UTF-8 plain text. The reported
browser MIME type is not trusted. Files are written using generated UUID keys
with restrictive file permissions, outside the static web root; downloads
require a fresh access check. Responses are attachment-only and `no-store`.
Keep the storage directory private and backed up according to your retention
requirements.

Deletion is a soft delete: the document becomes inaccessible immediately, but
the file remains in private storage for recovery/retention. A physical purge
policy is not implemented.

## Audit integrity and limitations

Audit events are append-only through the Mongoose model and contain a
monotonically sequenced SHA-256 hash chain. Admins can inspect events and run
`GET /api/admin/audit/verify` to detect missing, changed, or reordered records.
This is **tamper-evident, not tamper-proof**: an operator with direct database
write access could rewrite the entire collection and recalculate the chain.
For production evidence, restrict MongoDB roles, export or anchor chain heads
to separately controlled immutable storage, and define retention/access policy.
Database changes and audit inserts are not wrapped in a single transaction, so
a process/database failure between a successful change and its audit insert
can leave a gap; a production deployment requiring evidentiary guarantees
should add transaction-backed mutation+audit writes and external anchoring.

## Deployment (single service)

The backend serves the `frontend/` folder as static files, so one Node
service hosts both the UI and the API on one HTTPS origin. Example for Render
(Railway/Fly/a VM are equivalent):

1. Push the repository (both `backend/` and `frontend/`) to GitHub.
2. MongoDB Atlas → Network Access → allow the host's outbound IPs (or
   `0.0.0.0/0` for a demo) and create a database user.
3. Render → New Web Service → the repo. Root directory `backend`, build
   `npm ci`, start `npm start`, health check path `/api/health`.
4. Add a persistent disk mounted at `/var/data` (uploaded files live there;
   without a disk they vanish on every redeploy).
5. Environment variables:
   `NODE_ENV=production`, `MONGODB_URI=…`, `JWT_SECRET=<64 random chars>`,
   `CLIENT_ORIGIN=https://<your-service>.onrender.com` (exact, no trailing slash),
   `TRUST_PROXY=1`, `STORAGE_DIR=/var/data/private-storage`.
6. After the first deploy, open the Render shell and run `npm run seed`.

The cookie is `Secure` in production, so the site must be served over HTTPS
(Render does this automatically).

## API reference

See [API.md](./API.md) for endpoint methods, authorization, parameters, and
responses. The threat assumptions and known residual risks are listed in
[THREATS.md](./THREATS.md).

## Frontend

The plain HTML/CSS/JavaScript application lives separately in `../frontend/`.
The backend can serve it on the API origin with `npm start`, or run it
independently:

```powershell
Set-Location ..\frontend
npm start
```

The standalone frontend listens on `http://localhost:5173` by default. Set
backend `CLIENT_ORIGIN=http://localhost:5173` for this mode. Its API base URL is
configured in `frontend/config.js`: same origin by default, or
`http://localhost:3000/api` when opened on port 5173. For the backend-served
mode, set `CLIENT_ORIGIN` to the backend origin (e.g. `http://localhost:3000`);
no `config.js` change is needed. Set both to the actual HTTPS
origins when deploying. Sign in with a provisioned account; accounts are not
self-registered. Static frontend files contain no database or API secrets.

## Tests

`npm test` runs API-level authorization tests using isolated model stubs and
file-validation tests. They exercise direct requests as different roles and
verify denied reads/downloads/edits/deletes/sharing, revocation, admin
non-bypass, and denied-attempt audit records. They do not replace tests against
a real MongoDB deployment or a deployment-level penetration test.
