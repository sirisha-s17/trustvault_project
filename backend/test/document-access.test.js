process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/trustvault-test";
process.env.JWT_SECRET = "test-only-jwt-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const testStorageDir = path.join(os.tmpdir(), `trustvault-test-${process.pid}`);
process.env.STORAGE_DIR = testStorageDir;

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const request = require("supertest");
const app = require("../src/app");
const { jwtSecret } = require("../src/config/env");
const AuditEvent = require("../src/models/AuditEvent");
const Document = require("../src/models/Document");
const User = require("../src/models/User");
const appendAudit = require("../src/services/audit.service");
const { eventHash } = require("../src/services/audit.service");

const ownerId = new mongoose.Types.ObjectId();
const viewerId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const documentId = new mongoose.Types.ObjectId();
const baseUsers = [
  { _id: ownerId, id: String(ownerId), role: "owner", name: "Owner", email: "owner@example.test", active: true, tokenVersion: 0 },
  { _id: viewerId, id: String(viewerId), role: "viewer", name: "Viewer", email: "viewer@example.test", active: true, tokenVersion: 0 },
  { _id: adminId, id: String(adminId), role: "admin", name: "Admin", email: "admin@example.test", active: true, tokenVersion: 0 }
];
let users;

let documentRecord;
let auditEvents;
let lastListFilter;
let restoreMethods;

function makeDocument(grants = []) {
  return {
    _id: documentId,
    id: String(documentId),
    ownerId,
    grants,
    name: "confidential.pdf",
    category: "Legal",
    mimeType: "application/pdf",
    sizeBytes: 5,
    checksumSha256: "a".repeat(64),
    storageKey: "00000000-0000-4000-8000-000000000001",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    currentVersion: 1,
    versions: [],
    save: async function save() { return this; },
    populate: async function populate() { return this; }
  };
}

function tokenFor(userId) {
  return jwt.sign({ sub: String(userId), ver: 0 }, jwtSecret, { expiresIn: "5m" });
}

function authorized(userId, method, url) {
  return request(app)
    [method](url)
    .set("Cookie", `trustvault_token=${tokenFor(userId)}`)
    .set("Origin", "http://localhost:3000");
}

test.before(() => {
  const originals = {
    documentFindOne: Document.findOne,
    documentCreate: Document.create,
    documentFind: Document.find,
    documentCountDocuments: Document.countDocuments,
    userFindById: User.findById,
    userFindOne: User.findOne,
    userFind: User.find,
    auditFindOne: AuditEvent.findOne,
    auditCreate: AuditEvent.create
  };
  restoreMethods = () => {
    Document.findOne = originals.documentFindOne;
    Document.create = originals.documentCreate;
    Document.find = originals.documentFind;
    Document.countDocuments = originals.documentCountDocuments;
    User.findById = originals.userFindById;
    User.findOne = originals.userFindOne;
    User.find = originals.userFind;
    AuditEvent.findOne = originals.auditFindOne;
    AuditEvent.create = originals.auditCreate;
  };

  // Honours the ownerId and deletedAt filters the way MongoDB would, so removing
  // either filter from a route makes a test fail instead of being masked here.
  Document.findOne = (filter) => {
    const matches = () => {
      if (String(filter._id) !== String(documentId)) return false;
      if (filter.ownerId !== undefined && String(filter.ownerId) !== String(documentRecord.ownerId)) return false;
      if (filter.deletedAt === null) return !documentRecord.deletedAt;
      if (filter.deletedAt && filter.deletedAt.$ne === null) return Boolean(documentRecord.deletedAt);
      return true;
    };
    const result = matches() ? documentRecord : null;
    return {
      select: async () => result,
      then: (resolve, reject) => Promise.resolve(result).then(resolve, reject)
    };
  };
  Document.find = (filter) => {
    lastListFilter = filter;
    const chain = {
      select: () => chain,
      populate: () => chain,
      sort: () => chain,
      skip: () => chain,
      limit: () => chain,
      lean: async () => []
    };
    return chain;
  };
  Document.countDocuments = async () => 0;
  Document.create = async (data) => {
    documentRecord = Object.assign(makeDocument(), data, { _id: documentId, id: String(documentId) });
    return documentRecord;
  };
  User.findById = (id) => ({
    select: async () => users.get(String(id)) || null
  });
  User.findOne = (filter) => ({
    select: async () => users.get(String(filter._id)) || null
  });
  User.find = () => {
    const chain = { select: () => chain, limit: () => chain, lean: async () => [] };
    return chain;
  };
  AuditEvent.findOne = () => ({
    sort() {
      return this;
    },
    lean: async () => auditEvents[auditEvents.length - 1] || null
  });
  AuditEvent.create = async (event) => {
    auditEvents.push(event);
    return event;
  };
});

test.beforeEach(() => {
  documentRecord = makeDocument();
  auditEvents = [];
  lastListFilter = null;
  users = new Map(baseUsers.map((user) => [String(user._id), { ...user }]));
});

test("frontend static files are served from the standalone frontend folder", async () => {
  const [page, script, stylesheet] = await Promise.all([
    request(app).get("/"),
    request(app).get("/app.js"),
    request(app).get("/styles.css")
  ]);
  assert.equal(page.status, 200);
  assert.match(page.text, /config\.js/);
  assert.equal(script.status, 200);
  assert.match(script.text, /apiBaseUrl/);
  assert.equal(stylesheet.status, 200);
});

test("credentialed CORS only permits the configured frontend origin", async () => {
  const allowed = await request(app)
    .options("/api/auth/login")
    .set("Origin", "http://localhost:3000")
    .set("Access-Control-Request-Method", "POST");
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers["access-control-allow-origin"], "http://localhost:3000");
  assert.equal(allowed.headers["access-control-allow-credentials"], "true");

  const rejected = await request(app)
    .options("/api/auth/login")
    .set("Origin", "https://untrusted.example")
    .set("Access-Control-Request-Method", "POST");
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

test.after(async () => {
  restoreMethods();
  await fs.rm(testStorageDir, { recursive: true, force: true });
});

test("ungranted user cannot read, download, edit, delete, or manage grants by direct API calls", async () => {
  const id = String(documentId);
  const responses = await Promise.all([
    authorized(viewerId, "get", `/api/documents/${id}`),
    authorized(viewerId, "get", `/api/documents/${id}/download`),
    authorized(viewerId, "patch", `/api/documents/${id}`).send({ name: "stolen.pdf" }),
    authorized(viewerId, "delete", `/api/documents/${id}`),
    authorized(viewerId, "put", `/api/documents/${id}/permissions/${String(adminId)}`).send({ permission: "read" })
  ]);

  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.equal(response.body.error, "Document not found");
  }
  assert.equal(documentRecord.name, "confidential.pdf");
  assert.equal(auditEvents.filter((event) => event.action === "access_denied").length, 5);
});

test("read grant permits metadata only; edit grant permits edits; revocation applies on the next request", async () => {
  documentRecord.grants.push({ userId: viewerId, permission: "edit" });
  const id = String(documentId);

  const readResponse = await authorized(viewerId, "get", `/api/documents/${id}`);
  assert.equal(readResponse.status, 200);
  assert.equal(readResponse.body.document.name, "confidential.pdf");
  assert.equal(Object.hasOwn(readResponse.body.document, "storageKey"), false);

  const editResponse = await authorized(viewerId, "patch", `/api/documents/${id}`).send({ name: "renamed.pdf" });
  assert.equal(editResponse.status, 200);
  assert.equal(documentRecord.name, "renamed.pdf");

  documentRecord.grants = [];
  const afterRevocation = await authorized(viewerId, "get", `/api/documents/${id}`);
  assert.equal(afterRevocation.status, 404);
  assert.equal(auditEvents.some((event) => event.action === "edit" && event.outcome === "success"), true);
});

test("administrator role does not grant document-content access", async () => {
  const response = await authorized(adminId, "get", `/api/documents/${String(documentId)}`);
  assert.equal(response.status, 404);
  assert.equal(auditEvents.at(-1).action, "access_denied");
});

test("invalid document identifiers are denied and recorded", async () => {
  const response = await authorized(viewerId, "get", "/api/documents/not-an-object-id");
  assert.equal(response.status, 404);
  assert.equal(auditEvents.at(-1).details.reason, "invalid_document_id");
});

test("owner can grant and immediately revoke a named user's document access", async () => {
  const id = String(documentId);
  const targetId = String(viewerId);
  const grantResponse = await authorized(ownerId, "put", `/api/documents/${id}/permissions/${targetId}`)
    .send({ permission: "read" });
  assert.equal(grantResponse.status, 200);

  const accessAfterGrant = await authorized(viewerId, "get", `/api/documents/${id}`);
  assert.equal(accessAfterGrant.status, 200);

  const revokeResponse = await authorized(ownerId, "delete", `/api/documents/${id}/permissions/${targetId}`);
  assert.equal(revokeResponse.status, 204);
  const accessAfterRevoke = await authorized(viewerId, "get", `/api/documents/${id}`);
  assert.equal(accessAfterRevoke.status, 404);
  assert.equal(
    auditEvents.some((event) => event.action === "permission_revoke" && event.outcome === "success"),
    true
  );
});

test("upload rejects unsupported extensions before persisting a document", async () => {
  const response = await authorized(ownerId, "post", "/api/documents")
    .attach("file", Buffer.from("not a document"), { filename: "payload.exe", contentType: "application/octet-stream" });
  assert.equal(response.status, 415);
  assert.equal(auditEvents.at(-1).action, "upload");
  assert.equal(auditEvents.at(-1).outcome, "failure");
});

test("owner uploads a validated file and an authorized viewer downloads it privately", async () => {
  const contents = Buffer.from("%PDF-1.7\n");
  const uploadResponse = await authorized(ownerId, "post", "/api/documents")
    .field("name", "contract.pdf")
    .field("category", "Contracts")
    .attach("file", contents, { filename: "contract.pdf", contentType: "application/pdf" });
  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadResponse.body.document.name, "contract.pdf");
  assert.equal(documentRecord.mimeType, "application/pdf");

  const grantResponse = await authorized(ownerId, "put", `/api/documents/${String(documentId)}/permissions/${String(viewerId)}`)
    .send({ permission: "read" });
  assert.equal(grantResponse.status, 200);

  const downloadResponse = await authorized(viewerId, "get", `/api/documents/${String(documentId)}/download`);
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers["cache-control"], "private, no-store");
  assert.deepEqual(downloadResponse.body, contents);
  assert.equal(auditEvents.some((event) => event.action === "download" && event.outcome === "success"), true);
});

test("non-admin cannot read administrative activity", async () => {
  const response = await authorized(viewerId, "get", "/api/admin/audit");
  assert.equal(response.status, 403);
  assert.equal(auditEvents.at(-1).details.reason, "admin_required");
});

test("audit events are hash-linked in sequence", async () => {
  const first = await appendAudit({ action: "read", outcome: "success", actorId: viewerId });
  const second = await appendAudit({ action: "download", outcome: "success", actorId: viewerId });
  assert.equal(first.sequence, 1);
  assert.equal(first.previousHash, "0".repeat(64));
  assert.equal(first.hash, eventHash(first));
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.hash);
  assert.equal(second.hash, eventHash(second));

  const altered = { ...second, outcome: "denied" };
  assert.notEqual(altered.hash, eventHash(altered));
});

test("edit grantee cannot delete, share, revoke, or list permissions (owner-only actions)", async () => {
  documentRecord.grants.push({ userId: viewerId, permission: "edit" });
  const id = String(documentId);
  const responses = await Promise.all([
    authorized(viewerId, "delete", `/api/documents/${id}`),
    authorized(viewerId, "put", `/api/documents/${id}/permissions/${String(adminId)}`).send({ permission: "edit" }),
    authorized(viewerId, "delete", `/api/documents/${id}/permissions/${String(viewerId)}`),
    authorized(viewerId, "get", `/api/documents/${id}/permissions`)
  ]);
  for (const response of responses) {
    assert.equal(response.status, 403);
  }
  assert.equal(documentRecord.deletedAt, null);
  assert.equal(documentRecord.grants.length, 1);
  assert.equal(documentRecord.grants[0].permission, "edit");
  assert.equal(auditEvents.filter((event) => event.details?.reason === "owner_required").length, 4);
});

test("read grantee cannot edit metadata", async () => {
  documentRecord.grants.push({ userId: viewerId, permission: "read" });
  const response = await authorized(viewerId, "patch", `/api/documents/${String(documentId)}`).send({ name: "x.pdf" });
  assert.equal(response.status, 404);
  assert.equal(documentRecord.name, "confidential.pdf");
  assert.equal(auditEvents.at(-1).details.requestedPermission, "edit");
});

test("soft-deleted documents are unreachable even by their owner", async () => {
  documentRecord.deletedAt = new Date();
  const id = String(documentId);
  const responses = await Promise.all([
    authorized(ownerId, "get", `/api/documents/${id}`),
    authorized(ownerId, "get", `/api/documents/${id}/download`)
  ]);
  for (const response of responses) {
    assert.equal(response.status, 404);
  }
});

test("tokens issued before logout/deactivation stop working immediately", async () => {
  documentRecord.grants.push({ userId: viewerId, permission: "read" });
  const staleToken = tokenFor(viewerId);
  const url = `/api/documents/${String(documentId)}/download`;

  users.get(String(viewerId)).tokenVersion = 1;
  const afterLogout = await request(app).get(url).set("Cookie", `trustvault_token=${staleToken}`);
  assert.equal(afterLogout.status, 401);

  users.get(String(viewerId)).tokenVersion = 0;
  users.get(String(viewerId)).active = false;
  const afterDeactivation = await request(app).get(url).set("Cookie", `trustvault_token=${staleToken}`);
  assert.equal(afterDeactivation.status, 401);
  assert.equal(auditEvents.filter((event) => event.details?.reason === "inactive_or_missing_user").length, 2);
});

test("forged or unauthenticated requests are refused and recorded", async () => {
  const url = `/api/documents/${String(documentId)}`;
  const forged = jwt.sign({ sub: String(ownerId), ver: 0 }, "attacker-chosen-secret-that-is-long-enough");
  const responses = await Promise.all([
    request(app).get(url),
    request(app).get(url).set("Cookie", `trustvault_token=${forged}`)
  ]);
  for (const response of responses) {
    assert.equal(response.status, 401);
  }
  assert.deepEqual(
    auditEvents.map((event) => event.details.reason).sort(),
    ["invalid_or_expired_token", "missing_authentication"]
  );
});

test("state-changing requests from another origin are rejected (CSRF)", async () => {
  const response = await request(app)
    .delete(`/api/documents/${String(documentId)}`)
    .set("Cookie", `trustvault_token=${tokenFor(ownerId)}`)
    .set("Origin", "https://evil.example");
  assert.equal(response.status, 403);
  assert.equal(documentRecord.deletedAt, null);
  assert.equal(auditEvents.at(-1).details.reason, "untrusted_origin");
});

test("document search is always scoped to the caller's own or granted documents", async () => {
  // Even when the caller filters by another user's ownerId, the query must keep the access constraint.
  const response = await authorized(viewerId, "get", `/api/documents?scope=all&ownerId=${String(ownerId)}`);
  assert.equal(response.status, 200);
  assert.equal(lastListFilter.deletedAt, null);
  const accessClause = lastListFilter.$and[0].$or;
  assert.equal(String(accessClause[0].ownerId), String(viewerId));
  const grantMatch = accessClause[1].grants.$elemMatch;
  assert.equal(String(grantMatch.userId), String(viewerId));
  // Expired grants must not match: only "no expiry" or "expires in the future".
  assert.equal(grantMatch.$or[0].expiresAt, null);
  assert.ok(grantMatch.$or[1].expiresAt.$gt instanceof Date);
  assert.equal(accessClause.length, 2);
  assert.equal(lastListFilter.$or, undefined);
});

test("downloads use the server-verified file type for the extension", async () => {
  const upload = await authorized(ownerId, "post", "/api/documents")
    .field("name", "Quarterly report")
    .attach("file", Buffer.from("%PDF-1.7\n"), { filename: "report.pdf", contentType: "application/pdf" });
  assert.equal(upload.status, 201);
  const response = await authorized(ownerId, "get", `/api/documents/${String(documentId)}/download`);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-disposition"], /filename\*=UTF-8''Quarterly%20report\.pdf$/);
});

test("only owner-role accounts can upload", async () => {
  for (const userId of [viewerId, adminId]) {
    const response = await authorized(userId, "post", "/api/documents")
      .attach("file", Buffer.from("%PDF-1.7\n"), { filename: "x.pdf", contentType: "application/pdf" });
    assert.equal(response.status, 403);
    assert.equal(auditEvents.at(-1).details.reason, "owner_role_required");
  }
});

test("an expired grant gives no access, even though it is still stored", async () => {
  documentRecord.grants.push({ userId: viewerId, permission: "edit", expiresAt: new Date(Date.now() - 1000) });
  const id = String(documentId);
  const responses = await Promise.all([
    authorized(viewerId, "get", `/api/documents/${id}`),
    authorized(viewerId, "get", `/api/documents/${id}/download`),
    authorized(viewerId, "patch", `/api/documents/${id}`).send({ name: "late.pdf" })
  ]);
  for (const response of responses) {
    assert.equal(response.status, 404);
  }
  assert.equal(documentRecord.name, "confidential.pdf");

  documentRecord.grants[0].expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const beforeExpiry = await authorized(viewerId, "get", `/api/documents/${id}`);
  assert.equal(beforeExpiry.status, 200);
});

test("owner can grant time-limited access; past or far-future expiry is rejected", async () => {
  const url = `/api/documents/${String(documentId)}/permissions/${String(viewerId)}`;
  const past = await authorized(ownerId, "put", url).send({ permission: "read", expiresAt: "2000-01-01" });
  assert.equal(past.status, 400);
  const tooFar = await authorized(ownerId, "put", url).send({ permission: "read", expiresAt: "2999-01-01" });
  assert.equal(tooFar.status, 400);
  assert.equal(documentRecord.grants.length, 0);

  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const ok = await authorized(ownerId, "put", url).send({ permission: "read", expiresAt: nextWeek });
  assert.equal(ok.status, 200);
  assert.equal(documentRecord.grants[0].expiresAt.toISOString(), nextWeek);
  assert.equal(auditEvents.at(-1).details.expiresAt.toISOString(), nextWeek);
});

test("only the owner can restore a deleted document", async () => {
  documentRecord.deletedAt = new Date();
  documentRecord.grants.push({ userId: viewerId, permission: "edit" });
  const url = `/api/documents/${String(documentId)}/restore`;

  const byGrantee = await authorized(viewerId, "post", url);
  assert.equal(byGrantee.status, 404);
  assert.notEqual(documentRecord.deletedAt, null);
  assert.equal(auditEvents.at(-1).details.reason, "restore_not_permitted");

  const byOwner = await authorized(ownerId, "post", url);
  assert.equal(byOwner.status, 200);
  assert.equal(documentRecord.deletedAt, null);
  assert.equal(auditEvents.at(-1).action, "restore");
});

test("new file versions need an edit grant and keep the previous version", async () => {
  const url = `/api/documents/${String(documentId)}/file`;
  documentRecord.grants.push({ userId: viewerId, permission: "read" });
  const asReader = await authorized(viewerId, "put", url)
    .attach("file", Buffer.from("%PDF-1.7 v2\n"), { filename: "v2.pdf", contentType: "application/pdf" });
  assert.equal(asReader.status, 404);
  assert.equal(documentRecord.currentVersion, 1);

  documentRecord.grants[0].permission = "edit";
  const asEditor = await authorized(viewerId, "put", url)
    .attach("file", Buffer.from("%PDF-1.7 v2\n"), { filename: "v2.pdf", contentType: "application/pdf" });
  assert.equal(asEditor.status, 200);
  assert.equal(documentRecord.currentVersion, 2);
  assert.equal(documentRecord.versions.length, 1);
  assert.equal(documentRecord.versions[0].storageKey, "00000000-0000-4000-8000-000000000001");
  assert.equal(auditEvents.at(-1).action, "version_upload");
});

test("access suggestions are owner-only and never change who has access", async () => {
  documentRecord.grants.push({ userId: viewerId, permission: "edit" });
  const url = `/api/documents/${String(documentId)}/suggestions`;
  const byGrantee = await authorized(viewerId, "get", url);
  assert.equal(byGrantee.status, 403);

  const byOwner = await authorized(ownerId, "get", url);
  assert.equal(byOwner.status, 200);
  assert.ok(Array.isArray(byOwner.body.suggestions));
  assert.equal(documentRecord.grants.length, 1);
  assert.equal(auditEvents.at(-1).action, "access_suggestion");
});

test("a grant accepted from a suggestion is recorded as such in the audit", async () => {
  const response = await authorized(ownerId, "put", `/api/documents/${String(documentId)}/permissions/${String(viewerId)}`)
    .send({ permission: "read", source: "suggestion" });
  assert.equal(response.status, 200);
  assert.equal(auditEvents.at(-1).action, "permission_grant");
  assert.equal(auditEvents.at(-1).details.source, "suggestion");
});
