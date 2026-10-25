const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const { maxUploadBytes } = require("../config/env");
const authenticate = require("../middleware/authenticate");
const requireDocumentPermission = require("../middleware/requireDocumentPermission");
const AuditEvent = require("../models/AuditEvent");
const Document = require("../models/Document");
const User = require("../models/User");
const appendAudit = require("../services/audit.service");
const storage = require("../services/storage.service");
const {
  accessibleFilter,
  activeGrantMatch,
  isGrantActive,
  permissionFor
} = require("../services/access.service");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1, fields: 4, parts: 6 }
});
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false
});
const editableFields = new Set(["name", "category"]);
const extensionsByMimeType = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "text/plain": ".txt"
};
const MAX_GRANT_DAYS = 366;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Display names are free text, so the download name gets the extension of the
// server-verified type rather than whatever the uploader typed.
function downloadFileName(name, mimeType, version) {
  const extension = extensionsByMimeType[mimeType] || "";
  let base = name.replace(/[\r\n"]/g, "_");
  if (extension && base.toLowerCase().endsWith(extension)) {
    base = base.slice(0, -extension.length);
  }
  return `${base}${version ? ` (v${version})` : ""}${extension}`;
}

async function ownerOnly(req, res, next) {
  try {
    if (!req.document.ownerId.equals(req.user._id)) {
      await appendAudit({
        actorId: req.user._id,
        documentId: req.document._id,
        action: "access_denied",
        outcome: "denied",
        details: { reason: "owner_required", path: req.originalUrl }
      });
      return res.status(403).json({ error: "Only the document owner may do this" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireOwnerRole(req, res, next) {
  if (req.user.role === "owner") {
    return next();
  }
  return appendAudit({
    actorId: req.user._id,
    action: "access_denied",
    outcome: "denied",
    details: { reason: "owner_role_required", path: req.originalUrl }
  }).then(() => res.status(403).json({ error: "Only document owners may do this" })).catch(next);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function documentResponse(document) {
  return {
    id: String(document._id),
    name: document.name,
    category: document.category,
    ownerId: document.ownerId ? String(document.ownerId._id || document.ownerId) : null,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    checksumSha256: document.checksumSha256,
    currentVersion: document.currentVersion || 1,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}

// Validates the multipart file against the extension allowlist and its real
// content signature. Returns null (after auditing and responding) if invalid.
async function readValidatedFile(req, res, auditAction, documentId = null) {
  if (!req.file) {
    await appendAudit({
      actorId: req.user._id,
      documentId,
      action: auditAction,
      outcome: "failure",
      details: { reason: "file_required" }
    });
    res.status(400).json({ error: "A file is required" });
    return null;
  }
  const originalName = path.basename(req.file.originalname.replace(/[\\/]/g, "/"));
  const extension = path.extname(originalName).toLowerCase();
  const mimeType = storage.detectFileType(req.file.buffer, extension);
  if (!mimeType) {
    await appendAudit({
      actorId: req.user._id,
      documentId,
      action: auditAction,
      outcome: "failure",
      details: { reason: "unsupported_file_type", extension }
    });
    res.status(415).json({ error: "Unsupported file or file content does not match its extension" });
    return null;
  }
  return {
    originalName,
    mimeType,
    sizeBytes: req.file.size,
    checksumSha256: crypto.createHash("sha256").update(req.file.buffer).digest("hex")
  };
}

async function streamStoredFile(req, res, next, file) {
  const filePath = storage.getFilePath(file.storageKey);
  const stat = await fs.promises.stat(filePath).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!stat) {
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "download",
      outcome: "failure",
      details: { reason: "stored_file_missing", version: file.version }
    });
    return res.status(404).json({ error: "Document file not found" });
  }

  await appendAudit({
    actorId: req.user._id,
    documentId: req.document._id,
    action: "download",
    outcome: "success",
    details: { sizeBytes: stat.size, version: file.version, checksumSha256: file.checksumSha256 }
  });
  const fileName = downloadFileName(req.document.name, file.mimeType, file.isCurrent ? null : file.version);
  const encodedName = encodeURIComponent(fileName).replace(/['()]/g, escape);
  res.set({
    "Content-Type": file.mimeType,
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store"
  });
  const stream = fs.createReadStream(filePath);
  stream.on("error", next);
  return stream.pipe(res);
}

router.use(authenticate);

router.post("/", uploadLimiter, requireOwnerRole, upload.single("file"), async (req, res, next) => {
  let storageKey;
  let document;
  try {
    const file = await readValidatedFile(req, res, "upload");
    if (!file) return undefined;

    const name = (typeof req.body.name === "string" && req.body.name.trim() ? req.body.name : file.originalName).trim();
    const category = (typeof req.body.category === "string" && req.body.category.trim() ? req.body.category : "Uncategorized").trim();
    if (!name || name.length > 255 || !category || category.length > 100) {
      await appendAudit({
        actorId: req.user._id,
        action: "upload",
        outcome: "failure",
        details: { reason: "invalid_metadata" }
      });
      return res.status(400).json({ error: "Name must be 1-255 characters and category 1-100 characters" });
    }

    storageKey = await storage.saveFile(req.file.buffer);
    document = await Document.create({
      name,
      category,
      ownerId: req.user._id,
      storageKey,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      uploadedBy: req.user._id,
      fileUploadedAt: new Date()
    });
    await appendAudit({
      actorId: req.user._id,
      documentId: document._id,
      action: "upload",
      outcome: "success",
      details: { name, category, mimeType: file.mimeType, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256 }
    });

    return res.status(201).json({ document: documentResponse(document) });
  } catch (error) {
    if (document) {
      await Document.deleteOne({ _id: document._id }).catch((cleanupError) => console.error(cleanupError));
    }
    if (storageKey) {
      await storage.removeFile(storageKey).catch((cleanupError) => console.error(cleanupError));
    }
    return next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: "Invalid pagination" });
    }

    const now = new Date();
    // The access clause is always first; every user-supplied filter is only
    // ever appended to $and, so it can narrow results but never widen them.
    const filter = {
      deletedAt: null,
      $and: [accessibleFilter(req.user._id, now)]
    };
    if (req.query.scope === "owned") {
      filter.$and.push({ ownerId: req.user._id });
    } else if (req.query.scope === "shared") {
      filter.$and.push(activeGrantMatch(req.user._id, now));
    } else if (req.query.scope && req.query.scope !== "all") {
      return res.status(400).json({ error: "scope must be owned, shared, or all" });
    }
    if (req.query.name) {
      const name = String(req.query.name).trim();
      if (!name || name.length > 100) {
        return res.status(400).json({ error: "Name search must be 1-100 characters" });
      }
      filter.$and.push({ name: { $regex: escapeRegex(name), $options: "i" } });
    }
    if (req.query.category) {
      const category = String(req.query.category).trim();
      if (!category || category.length > 100) {
        return res.status(400).json({ error: "Category must be 1-100 characters" });
      }
      filter.$and.push({ category: { $regex: `^${escapeRegex(category)}$`, $options: "i" } });
    }
    if (req.query.ownerId) {
      if (typeof req.query.ownerId !== "string" || !mongoose.isValidObjectId(req.query.ownerId)) {
        return res.status(400).json({ error: "Invalid ownerId" });
      }
      filter.$and.push({ ownerId: req.query.ownerId });
    }
    if (req.query.owner) {
      const owner = String(req.query.owner).trim();
      if (!owner || owner.length > 100) {
        return res.status(400).json({ error: "Owner search must be 1-100 characters" });
      }
      const escapedOwner = escapeRegex(owner);
      const owners = await User.find({
        $or: [
          { name: { $regex: escapedOwner, $options: "i" } },
          { email: { $regex: escapedOwner, $options: "i" } }
        ]
      }).select("_id").limit(50).lean();
      filter.$and.push({ ownerId: { $in: owners.map((entry) => entry._id) } });
    }
    if (req.query.from || req.query.to) {
      const from = req.query.from ? validDate(req.query.from) : null;
      const to = req.query.to ? validDate(req.query.to) : null;
      if ((req.query.from && !from) || (req.query.to && !to)) {
        return res.status(400).json({ error: "Dates must be valid ISO dates" });
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
        to.setUTCHours(23, 59, 59, 999);
      }
      if (from && to && from > to) {
        return res.status(400).json({ error: "from must not be later than to" });
      }
      const createdAt = {};
      if (from) createdAt.$gte = from;
      if (to) createdAt.$lte = to;
      filter.$and.push({ createdAt });
    }

    const [documents, total] = await Promise.all([
      Document.find(filter)
        .select("name category ownerId mimeType sizeBytes checksumSha256 currentVersion createdAt updatedAt grants")
        .populate("ownerId", "name email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Document.countDocuments(filter)
    ]);

    await appendAudit({
      actorId: req.user._id,
      action: "search",
      outcome: "success",
      details: {
        page,
        limit,
        resultCount: documents.length,
        query: Object.fromEntries(
          ["scope", "name", "category", "owner", "from", "to"]
            .filter((key) => typeof req.query[key] === "string")
            .map((key) => [key, req.query[key].slice(0, 100)])
        )
      }
    });
    return res.json({
      documents: documents.map((document) => {
        const ownGrant = document.grants.find(
          (grant) => String(grant.userId) === String(req.user._id) && isGrantActive(grant, now)
        );
        return {
          ...documentResponse(document),
          owner: document.ownerId?._id
            ? { id: String(document.ownerId._id), name: document.ownerId.name, email: document.ownerId.email }
            : null,
          permission: permissionFor(document, req.user._id, now),
          accessExpiresAt: ownGrant?.expiresAt || null,
          sharedWith: String(document.ownerId?._id || document.ownerId) === String(req.user._id)
            ? document.grants.filter((grant) => isGrantActive(grant, now)).length
            : undefined
        };
      }),
      page,
      limit,
      total
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    const now = new Date();
    const [owned, shared, accessible, trash, categories] = await Promise.all([
      Document.countDocuments({ ownerId: req.user._id, deletedAt: null }),
      Document.countDocuments({ ...activeGrantMatch(req.user._id, now), deletedAt: null }),
      Document.countDocuments({ deletedAt: null, ...accessibleFilter(req.user._id, now) }),
      Document.countDocuments({ ownerId: req.user._id, deletedAt: { $ne: null } }),
      Document.distinct("category", { deletedAt: null, ...accessibleFilter(req.user._id, now) })
    ]);
    return res.json({ owned, shared, accessible, trash, categories: categories.sort() });
  } catch (error) {
    return next(error);
  }
});

router.get("/trash", requireOwnerRole, async (req, res, next) => {
  try {
    const documents = await Document.find({ ownerId: req.user._id, deletedAt: { $ne: null } })
      .select("name category ownerId mimeType sizeBytes checksumSha256 currentVersion createdAt updatedAt deletedAt")
      .sort({ deletedAt: -1 })
      .limit(200)
      .lean();
    return res.json({
      documents: documents.map((document) => ({ ...documentResponse(document), deletedAt: document.deletedAt }))
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", requireDocumentPermission("read"), async (req, res, next) => {
  try {
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "read",
      outcome: "success"
    });
    const ownGrant = req.document.grants.find((grant) => grant.userId.equals(req.user._id));
    return res.json({
      document: {
        ...documentResponse(req.document),
        permission: permissionFor(req.document, req.user._id),
        accessExpiresAt: ownGrant?.expiresAt || null
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/download", requireDocumentPermission("read"), async (req, res, next) => {
  try {
    return await streamStoredFile(req, res, next, {
      storageKey: req.document.storageKey,
      mimeType: req.document.mimeType,
      checksumSha256: req.document.checksumSha256,
      version: req.document.currentVersion || 1,
      isCurrent: true
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", requireDocumentPermission("edit"), async (req, res, next) => {
  try {
    const keys = Object.keys(req.body || {});
    if (!keys.length || keys.some((key) => !editableFields.has(key))) {
      return res.status(400).json({ error: "Only name and category can be changed" });
    }
    if (
      (req.body.name !== undefined && (typeof req.body.name !== "string" || !req.body.name.trim() || req.body.name.trim().length > 255)) ||
      (req.body.category !== undefined && (typeof req.body.category !== "string" || !req.body.category.trim() || req.body.category.trim().length > 100))
    ) {
      return res.status(400).json({ error: "Invalid name or category" });
    }

    const previous = Object.fromEntries(keys.map((key) => [key, req.document[key]]));
    if (req.body.name !== undefined) req.document.name = req.body.name.trim();
    if (req.body.category !== undefined) req.document.category = req.body.category.trim();
    await req.document.save();
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "edit",
      outcome: "success",
      details: {
        changedFields: keys,
        previous,
        current: Object.fromEntries(keys.map((key) => [key, req.document[key]]))
      }
    });
    return res.json({ document: documentResponse(req.document) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", requireDocumentPermission("edit"), ownerOnly, async (req, res, next) => {
  try {
    req.document.deletedAt = new Date();
    req.document.deletedBy = req.user._id;
    await req.document.save();
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "delete",
      outcome: "success",
      details: { name: req.document.name }
    });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

// Restore is the one route that must find a deleted document, so it cannot use
// requireDocumentPermission. Ownership is part of the query itself.
router.post("/:id/restore", async (req, res, next) => {
  try {
    const document = mongoose.isValidObjectId(req.params.id)
      ? await Document.findOne({ _id: req.params.id, ownerId: req.user._id, deletedAt: { $ne: null } })
      : null;
    if (!document) {
      await appendAudit({
        actorId: req.user._id,
        action: "access_denied",
        outcome: "denied",
        details: { reason: "restore_not_permitted", requestedDocumentId: String(req.params.id), path: req.originalUrl }
      });
      return res.status(404).json({ error: "Document not found in your trash" });
    }
    document.deletedAt = null;
    document.deletedBy = null;
    await document.save();
    await appendAudit({
      actorId: req.user._id,
      documentId: document._id,
      action: "restore",
      outcome: "success",
      details: { name: document.name }
    });
    return res.json({ document: documentResponse(document) });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/versions", requireDocumentPermission("read", { withVersions: true }), async (req, res, next) => {
  try {
    const document = req.document;
    const entries = [
      {
        version: document.currentVersion || 1,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        checksumSha256: document.checksumSha256,
        uploadedBy: document.uploadedBy || document.ownerId,
        uploadedAt: document.fileUploadedAt || document.createdAt,
        current: true
      },
      ...[...(document.versions || [])].reverse().map((entry) => ({
        version: entry.version,
        mimeType: entry.mimeType,
        sizeBytes: entry.sizeBytes,
        checksumSha256: entry.checksumSha256,
        uploadedBy: entry.uploadedBy,
        uploadedAt: entry.uploadedAt,
        current: false
      }))
    ];
    const uploaders = await User.find({ _id: { $in: entries.map((entry) => entry.uploadedBy) } })
      .select("name email").lean();
    const names = new Map(uploaders.map((user) => [String(user._id), user.name]));
    return res.json({
      versions: entries.map((entry) => ({
        ...entry,
        uploadedBy: { id: String(entry.uploadedBy), name: names.get(String(entry.uploadedBy)) || "Unknown" }
      }))
    });
  } catch (error) {
    return next(error);
  }
});

// Permission is checked before multer parses the body, so an unauthorised
// caller cannot make the server buffer a 25 MB upload.
router.put(
  "/:id/file",
  uploadLimiter,
  requireDocumentPermission("edit", { withVersions: true }),
  upload.single("file"),
  async (req, res, next) => {
    let storageKey;
    try {
      const document = req.document;
      const file = await readValidatedFile(req, res, "version_upload", document._id);
      if (!file) return undefined;
      if (file.checksumSha256 === document.checksumSha256) {
        return res.status(409).json({ error: "This file is identical to the current version" });
      }

      storageKey = await storage.saveFile(req.file.buffer);
      const previousVersion = document.currentVersion || 1;
      document.versions.push({
        version: previousVersion,
        storageKey: document.storageKey,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        checksumSha256: document.checksumSha256,
        uploadedBy: document.uploadedBy || document.ownerId,
        uploadedAt: document.fileUploadedAt || document.createdAt
      });
      document.storageKey = storageKey;
      document.mimeType = file.mimeType;
      document.sizeBytes = file.sizeBytes;
      document.checksumSha256 = file.checksumSha256;
      document.currentVersion = previousVersion + 1;
      document.uploadedBy = req.user._id;
      document.fileUploadedAt = new Date();
      await document.save();
      storageKey = null;
      await appendAudit({
        actorId: req.user._id,
        documentId: document._id,
        action: "version_upload",
        outcome: "success",
        details: {
          version: document.currentVersion,
          previousVersion,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          checksumSha256: file.checksumSha256
        }
      });
      return res.json({ document: documentResponse(document) });
    } catch (error) {
      if (storageKey) {
        await storage.removeFile(storageKey).catch((cleanupError) => console.error(cleanupError));
      }
      return next(error);
    }
  }
);

router.get(
  "/:id/versions/:version/download",
  requireDocumentPermission("read", { withVersions: true }),
  async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      const document = req.document;
      if (!Number.isInteger(version) || version < 1) {
        return res.status(400).json({ error: "Invalid version" });
      }
      const isCurrent = version === (document.currentVersion || 1);
      const entry = isCurrent ? document : (document.versions || []).find((item) => item.version === version);
      if (!entry) {
        return res.status(404).json({ error: "Version not found" });
      }
      return await streamStoredFile(req, res, next, {
        storageKey: entry.storageKey,
        mimeType: entry.mimeType,
        checksumSha256: entry.checksumSha256,
        version,
        isCurrent
      });
    } catch (error) {
      return next(error);
    }
  }
);

router.get("/:id/activity", requireDocumentPermission("read"), ownerOnly, async (req, res, next) => {
  try {
    const events = await AuditEvent.find({ documentId: req.document._id })
      .populate("actorId", "name email role")
      .sort({ sequence: -1 })
      .limit(100)
      .lean();
    return res.json({
      events: events.map((event) => ({
        sequence: event.sequence,
        action: event.action,
        outcome: event.outcome,
        occurredAt: event.occurredAt,
        actor: event.actorId
          ? { id: String(event.actorId._id), name: event.actorId.name, email: event.actorId.email }
          : null,
        details: event.details || {}
      }))
    });
  } catch (error) {
    return next(error);
  }
});

// Suggests people for the owner to consider. It never grants anything: the
// owner must confirm through PUT /permissions, and both the suggestion and the
// decision are written to the audit trail.
router.get("/:id/suggestions", requireDocumentPermission("read"), ownerOnly, async (req, res, next) => {
  try {
    const now = new Date();
    const document = req.document;
    const alreadyIncluded = new Set([
      String(document.ownerId),
      ...document.grants.filter((grant) => isGrantActive(grant, now)).map((grant) => String(grant.userId))
    ]);
    const otherDocuments = await Document.find({
      ownerId: req.user._id,
      deletedAt: null,
      _id: { $ne: document._id }
    }).select("category grants").lean();

    const scores = new Map();
    for (const other of otherDocuments) {
      const sameCategory = other.category.toLowerCase() === document.category.toLowerCase();
      for (const grant of other.grants) {
        const userId = String(grant.userId);
        if (alreadyIncluded.has(userId) || !isGrantActive(grant, now)) continue;
        const entry = scores.get(userId) || { score: 0, sameCategory: 0, other: 0, permissions: new Set() };
        entry.score += sameCategory ? 3 : 1;
        entry[sameCategory ? "sameCategory" : "other"] += 1;
        entry.permissions.add(grant.permission);
        scores.set(userId, entry);
      }
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 10);
    const users = await User.find({ _id: { $in: ranked.map(([id]) => id) }, active: true })
      .select("name email role").lean();
    const usersById = new Map(users.map((user) => [String(user._id), user]));
    const suggestions = ranked
      .filter(([id]) => usersById.has(id))
      .slice(0, 5)
      .map(([id, entry]) => {
        const user = usersById.get(id);
        const reasons = [];
        if (entry.sameCategory) {
          reasons.push(`has access to ${entry.sameCategory} other "${document.category}" document${entry.sameCategory === 1 ? "" : "s"} you own`);
        }
        if (entry.other) {
          reasons.push(`has access to ${entry.other} of your documents in other categories`);
        }
        return {
          user: { id, name: user.name, email: user.email, role: user.role },
          suggestedPermission: "read",
          reason: reasons.join("; "),
          score: entry.score
        };
      });

    await appendAudit({
      actorId: req.user._id,
      documentId: document._id,
      action: "access_suggestion",
      outcome: "success",
      details: {
        engine: "co-access-v1",
        suggestedUserIds: suggestions.map((item) => item.user.id),
        suggestedPermission: "read"
      }
    });
    return res.json({ suggestions });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/permissions", requireDocumentPermission("read"), ownerOnly, async (req, res, next) => {
  try {
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "read",
      outcome: "success",
      details: { resource: "permissions" }
    });
    await req.document.populate("grants.userId", "name email role active");
    const now = new Date();
    return res.json({
      grants: req.document.grants.map((grant) => ({
        user: grant.userId
          ? { id: String(grant.userId._id || grant.userId), name: grant.userId.name, email: grant.userId.email, active: grant.userId.active }
          : null,
        permission: grant.permission,
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt || null,
        expired: !isGrantActive(grant, now)
      }))
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/:id/permissions/:userId", requireDocumentPermission("edit"), ownerOnly, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const permission = req.body?.permission;
    const source = req.body?.source === "suggestion" ? "suggestion" : "manual";
    if (!mongoose.isValidObjectId(userId) || !["read", "edit"].includes(permission)) {
      return res.status(400).json({ error: "Valid userId and read/edit permission are required" });
    }
    let expiresAt = null;
    if (req.body?.expiresAt !== undefined && req.body.expiresAt !== null && req.body.expiresAt !== "") {
      expiresAt = validDate(req.body.expiresAt);
      if (expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(req.body.expiresAt)) {
        expiresAt.setUTCHours(23, 59, 59, 999);
      }
      const latest = Date.now() + MAX_GRANT_DAYS * 24 * 60 * 60 * 1000;
      if (!expiresAt || expiresAt <= new Date() || expiresAt.getTime() > latest) {
        return res.status(400).json({ error: "expiresAt must be a future date within one year" });
      }
    }
    if (String(userId) === String(req.document.ownerId)) {
      return res.status(400).json({ error: "The document owner cannot receive a separate grant" });
    }
    const target = await User.findOne({ _id: userId, active: true }).select("_id email");
    if (!target) {
      return res.status(404).json({ error: "Active user not found" });
    }
    const previous = req.document.grants.find((grant) => grant.userId.equals(target._id));
    req.document.grants = req.document.grants.filter((grant) => !grant.userId.equals(target._id));
    req.document.grants.push({
      userId: target._id,
      permission,
      grantedBy: req.user._id,
      grantedAt: new Date(),
      expiresAt
    });
    await req.document.save();
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "permission_grant",
      outcome: "success",
      details: {
        targetUserId: target._id,
        targetEmail: target.email,
        permission,
        previousPermission: previous?.permission || null,
        expiresAt,
        source
      }
    });
    return res.json({ userId: String(target._id), permission, expiresAt });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id/permissions/:userId", requireDocumentPermission("edit"), ownerOnly, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(400).json({ error: "Invalid userId" });
    }
    const grant = req.document.grants.find((entry) => entry.userId.equals(userId));
    if (!grant) {
      await appendAudit({
        actorId: req.user._id,
        documentId: req.document._id,
        action: "permission_revoke",
        outcome: "failure",
        details: { targetUserId: userId, reason: "grant_not_found" }
      });
      return res.status(404).json({ error: "Grant not found" });
    }
    req.document.grants = req.document.grants.filter((entry) => !entry.userId.equals(userId));
    await req.document.save();
    await appendAudit({
      actorId: req.user._id,
      documentId: req.document._id,
      action: "permission_revoke",
      outcome: "success",
      details: { targetUserId: userId, revokedPermission: grant.permission }
    });
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
