# TrustVault backend threat notes

## Access control threats addressed

| Threat | Mitigation | Automated coverage |
| --- | --- | --- |
| Guessing another document ID to read metadata | Server queries current document and owner/grant before response; same 404 for absent/inaccessible IDs | `ungranted user cannot read, download, edit, delete, or manage grants by direct API calls` |
| Calling the download URL directly or replaying a prior share | Every download performs authentication and current grant lookup; no public/signed links | Same direct-route denial test; `owner can grant and immediately revoke a named user's document access` |
| Editing/deleting/sharing through hidden or guessed API routes | Edit middleware; deletion and permission operations additionally require ownership | Direct PATCH, DELETE, and permission PUT denial test |
| Administrator implicitly reading confidential content | Admin has no document access bypass | `administrator role does not grant document-content access` |
| Continued access after grant revocation | Grants are read from MongoDB on each request; no long-lived file URL | Grant/revoke test makes a second request after revocation |
| User account disabled but existing JWT remains usable | Auth checks the active user and token version on every request; logout increments token version | `tokens issued before logout/deactivation stop working immediately` |
| Forged JWT (own secret / `alg` tricks) or no cookie at all | `jwt.verify` with server secret; refused attempts are audited | `forged or unauthenticated requests are refused and recorded` |
| Edit grantee escalating to sharing, revoking others, or deleting | `ownerOnly` runs after the edit check on delete and every permissions route | `edit grantee cannot delete, share, revoke, or list permissions (owner-only actions)` |
| Read grantee changing metadata | `PATCH` requires an `edit` grant | `read grantee cannot edit metadata` |
| Reaching a soft-deleted document by ID | Permission lookup filters `deletedAt: null`; test stub honours that filter so removing it fails the test | `soft-deleted documents are unreachable even by their owner` |
| Search/listing used to enumerate other users' documents (e.g. `?ownerId=<victim>`) | Access `$or` is always the first `$and` clause; user filters are only appended | `document search is always scoped to the caller's own or granted documents` |
| Cross-site request forgery with the session cookie (`SameSite=None` in production) | Non-GET requests require exact `Origin`; GETs have no side effects other than audit | `state-changing requests from another origin are rejected (CSRF)` |
| Viewer/admin uploading documents | Upload requires owner role | `only owner-role accounts can upload` |
| Partner keeps access after the engagement ends | Optional `expiresAt` per grant, checked in both the per-document check and the search query | `an expired grant gives no access, even though it is still stored`; search test asserts the expiry clause |
| Setting a grant that never meaningfully expires, or one already expired | Expiry must be in the future and within one year | `owner can grant time-limited access; past or far-future expiry is rejected` |
| Restoring someone else's deleted document (restore cannot use the normal middleware, which excludes deleted docs) | Ownership is part of the restore query itself | `only the owner can restore a deleted document` |
| Read grantee replacing the file; anyone forcing the server to buffer a 25 MB upload | New versions need `edit`; permission is checked before multer parses the body | `new file versions need an edit grant and keep the previous version` |
| Old version download as a side door after a new version is uploaded | Version downloads go through the same read check and are audited with the version number | Same middleware as download (covered by direct-route tests) |
| AI/suggestion widening access on its own | Suggestions endpoint is read-only and owner-only; granting is a separate, explicit owner call tagged `source: "suggestion"` | `access suggestions are owner-only and never change who has access`; `a grant accepted from a suggestion is recorded as such in the audit` |
| Suggestions leaking who else has access to an owner's documents | Suggestions only draw on the *calling owner's own* documents' grants | Owner-only test above |
| Admin learning confidential document names via oversight screens | Overview and bulk transfer expose document IDs only | Not automated |
| Offboarded owner's documents left orphaned or readable by the leaver | Bulk transfer moves every document (including trash) and removes grants for old/new owner; deactivation removes grants and bumps token version | Not automated |
| Uploading executable content disguised as an allowed file | Extension allowlist plus content-signature/UTF-8 validation; private generated storage key | `file content signatures must match the extension allowlist`; unsupported upload API test |
| Traversal via uploaded/downloaded filename | Client filename is metadata only; storage uses a generated UUID and resolved private path | Validation tests cover type mismatch; add deployment tests for storage path and response headers |
| Brute-force login and user enumeration | Login limiter (failed attempts only) and exact-email lookup limits; owner role required for lookup; `TRUST_PROXY` makes limits per client instead of per load balancer | Rate-limit behavior is not currently exercised by automated tests |
| Flooding the audit trail / database with refused requests (every denial writes an event) | Global 300 requests/minute/IP limit on `/api` | Not automated |
| Missing or altered audit entries | Monotonic sequence and SHA-256 predecessor chain; Mongoose blocks model updates/deletes; admin verification endpoint | Denied-attempt audit assertions; chain verification should additionally be tested against a real MongoDB |

## Accepted limitations and deployment risks

1. **Database administrator can rewrite evidence.** Hash chaining detects
   partial edits/deletions/reordering, but a principal able to replace the full
   collection can recompute the chain. Use restricted credentials, immutable
   external archival, and periodically anchored hashes for evidentiary use.
2. **Mutation/audit atomicity is not guaranteed.** A process or database failure
   between persisting a document/grant change and appending its event may leave
   an unaudited change. MongoDB transactions plus an external append-only sink
   are required before claiming forensic-grade audit guarantees.
3. **File storage location.** With `STORAGE_DRIVER=gridfs` file bytes sit in MongoDB, so anyone holding database credentials can read them directly (same as anyone with access to the storage disk in `disk` mode); there is no per-file encryption at rest beyond what Atlas provides. In `disk` mode: All API instances must share
   the same private durable volume. A missing/incorrect volume prevents
   downloads; do not expose this directory through a static web server.
   Production multi-region/object-storage use is not implemented.
4. **Soft deletion retains file bytes.** Access is blocked immediately, but
   physical secure erasure, retention scheduling, and restore workflows are
   not implemented.
5. **Image/PDF content safety is not content sanitization.** Files are served as
   downloads with `nosniff`, not rendered inline. Malware scanning, content
   disarm/reconstruction, and data-loss prevention are outside this backend.
6. **Origin checking is not a substitute for deployment controls.** Keep the
   frontend same-origin, use HTTPS, restrict MongoDB network access, secure
   backups, configure trusted proxy/IP behavior for rate limits, and run tests
   against the deployed infrastructure.
6a. **Demo credentials are public.** The README lists seeded passwords so
   judges can sign in. Anyone can therefore sign in as those demo users; that
   is the point of a demo, but no real data may be put in that deployment.
6b. **Edit grantees can replace the file.** That is what "edit" means here; the
   old version is kept and the replacement is audited, so it is recoverable
   and attributable, but an editor can make the current version misleading.
7. **Revocation does not abort an in-flight download.** A transfer that has
   already passed the check finishes; the next request is denied.
8. **Automated tests use model stubs.** They prove routes enforce authorization
   but do not validate MongoDB index setup, concurrent operations, replica-set
   behavior, or real file permissions. Those need integration/deployment tests.
