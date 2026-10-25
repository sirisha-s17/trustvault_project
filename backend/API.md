# TrustVault API

All API routes are under `/api`. The frontend can be hosted separately; configure
its API base URL in `frontend/config.js` and set backend `CLIENT_ORIGIN` to the
exact frontend origin. The API permits credentialed CORS only for that origin.
Production cross-origin cookies require HTTPS. JSON request bodies are limited
to 32 KiB.
Send the `trustvault_token` HTTP-only cookie obtained from login. Every
state-changing request must include an `Origin` exactly equal to `CLIENT_ORIGIN`.
Unauthorized or inaccessible document IDs return `404` to reduce existence
disclosure. All times are UTC ISO-8601 values.

## Authentication

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | `/health` | Public | API liveness |
| POST | `/auth/login` | Public, rate-limited | Body `{ "email", "password" }`; sets HTTP-only cookie |
| POST | `/auth/logout` | Authenticated | Increments token version, invalidating all current tokens |
| GET | `/auth/me` | Authenticated | Current user identity and role |
| POST | `/auth/password` | Authenticated, rate-limited | `{ "currentPassword", "newPassword" }` (12+); ends all other sessions |

## Documents

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| POST | `/documents` | Owner role | Multipart form with `file`, optional `name`, `category`; size/signature validated |
| GET | `/documents` | Authenticated with access | Search accessible docs; optional `name`, `category`, `owner` (owner name/email), `ownerId`, `scope` (`owned`, `shared`, `all`), `from`, `to`, `page`, `limit` |
| GET | `/documents/summary` | Authenticated | Counts only the caller's owned, shared, and total accessible documents |
| GET | `/documents/:id` | Owner or read/edit grant | Read metadata; creates a read audit event |
| GET | `/documents/:id/download` | Owner or read/edit grant | Private attachment download; rechecks current grant on every request |
| PATCH | `/documents/:id` | Owner or edit grant | JSON `name` and/or `category` only |
| DELETE | `/documents/:id` | Owner only | Soft-delete; the file becomes inaccessible |
| GET | `/documents/:id/permissions` | Owner only | List current named grants |
| PUT | `/documents/:id/permissions/:userId` | Owner only | JSON `{ "permission": "read" \| "edit" }`; creates or changes a grant |
| DELETE | `/documents/:id/permissions/:userId` | Owner only | Revokes a grant immediately |
| GET | `/documents/trash` | Owner role | The caller's own soft-deleted documents |
| POST | `/documents/:id/restore` | Owner only (ownership is part of the query) | Restore from trash; previous grants apply again |
| GET | `/documents/:id/versions` | Owner or read/edit grant | Version history (current first) |
| PUT | `/documents/:id/file` | Owner or edit grant | Multipart `file`; uploads a new version, keeps the old one. Permission is checked before the body is parsed |
| GET | `/documents/:id/versions/:version/download` | Owner or read/edit grant | Download a specific version; audited with the version number |
| GET | `/documents/:id/activity` | Owner only | Last 100 audit events for this document, including refused attempts |
| GET | `/documents/:id/suggestions` | Owner only | Suggested people (co-access heuristic). Grants nothing; the suggestion is audited |

`PUT /documents/:id/permissions/:userId` also accepts optional `expiresAt`
(ISO date, future, at most one year ahead; a bare date means end of that day
UTC) and `source` (`manual` or `suggestion`, recorded in the audit). Expired
grants stay stored for the record but match nothing: neither the per-document
check nor the search query accepts them.

The document listing requires current owner/grant access as part of the MongoDB
query; clients cannot ask for arbitrary documents by ID and bypass the
per-document middleware.

## Users and administration

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| GET | `/users/lookup?email=...` | Owner role | Exact email lookup for naming a grant recipient; rate-limited |
| GET | `/admin/users` | Admin | Paginated user listing; optional `role` filter |
| POST | `/admin/users` | Admin | Create user with `name`, `email`, `password` (12+ characters), `role` |
| PATCH | `/admin/users/:id/active` | Admin | Activate/deactivate; self-deactivation and last-admin lockout are prevented |
| PUT | `/admin/documents/:id/owner` | Admin | Transfer ownership to an active owner-role account |
| GET | `/admin/audit` | Admin | Paginated audit search; filters: `actorId`, `documentId`, `action`, `outcome`, `from`, `to` |
| GET | `/admin/audit/verify` | Admin | Verify sequence, previous-hash links, and event hashes |
| GET | `/admin/overview` | Admin | 24h counts, alerts (repeated refusals, download spikes, password guessing), recent permission changes and refusals. Document IDs only, never names |
| POST | `/admin/users/:id/password` | Admin | `{ "password" }` (12+); resets and signs the user out everywhere |
| POST | `/admin/users/:id/transfer-documents` | Admin | `{ "toUserId" }` (active owner); moves every document, including trash, without exposing names |

Administrator status does not grant document-content access. Deactivation
removes the user's document grants and invalidates tokens. An owner with active
documents must transfer them before deactivation.

## Audit actions

The API records authentication outcomes, document upload/read/download/edit/
delete, search, grant/revoke, account changes, ownership transfer, and denied
access. Audit events have actor/document IDs where available, UTC time,
outcome, structured details, sequence, previous hash, and event hash.
