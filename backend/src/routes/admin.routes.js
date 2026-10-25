const bcrypt = require("bcryptjs");
const express = require("express");
const mongoose = require("mongoose");
const authenticate = require("../middleware/authenticate");
const AuditEvent = require("../models/AuditEvent");
const Document = require("../models/Document");
const User = require("../models/User");
const appendAudit = require("../services/audit.service");
const { eventHash } = require("../services/audit.service");

const router = express.Router();
const roles = ["admin", "owner", "viewer"];
const auditActions = AuditEvent.schema.path("action").enumValues;

async function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    try {
      await appendAudit({
        actorId: req.user._id,
        action: "access_denied",
        outcome: "denied",
        details: { reason: "admin_required", path: req.originalUrl }
      });
      return res.status(403).json({ error: "Administrator role required" });
    } catch (error) {
      return next(error);
    }
  }
  return next();
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

router.use(authenticate);

router.get("/audit", requireAdmin, async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 50);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: "Invalid pagination" });
    }
    const filter = {};
    for (const field of ["actorId", "documentId"]) {
      if (req.query[field]) {
        if (!mongoose.isValidObjectId(req.query[field])) {
          return res.status(400).json({ error: `Invalid ${field}` });
        }
        filter[field] = req.query[field];
      }
    }
    if (req.query.action) {
      if (!auditActions.includes(req.query.action)) {
        return res.status(400).json({ error: "Invalid action" });
      }
      filter.action = req.query.action;
    }
    if (req.query.outcome) {
      if (!["success", "denied", "failure"].includes(req.query.outcome)) {
        return res.status(400).json({ error: "Invalid outcome" });
      }
      filter.outcome = req.query.outcome;
    }
    if (req.query.from || req.query.to) {
      const from = req.query.from ? parseDate(req.query.from) : null;
      const to = req.query.to ? parseDate(req.query.to) : null;
      if ((req.query.from && !from) || (req.query.to && !to)) {
        return res.status(400).json({ error: "Invalid date range" });
      }
      if (to && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
        to.setUTCHours(23, 59, 59, 999);
      }
      if (from && to && from > to) {
        return res.status(400).json({ error: "Invalid date range" });
      }
      filter.occurredAt = {};
      if (from) filter.occurredAt.$gte = from;
      if (to) filter.occurredAt.$lte = to;
    }

    const [events, total] = await Promise.all([
      AuditEvent.find(filter)
        .populate("actorId", "name email role")
        .sort({ sequence: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AuditEvent.countDocuments(filter)
    ]);
    return res.json({ events, page, limit, total });
  } catch (error) {
    return next(error);
  }
});

router.get("/audit/verify", requireAdmin, async (req, res, next) => {
  try {
    let expectedSequence = 1;
    let previousHash = "0".repeat(64);
    const cursor = AuditEvent.find().sort({ sequence: 1 }).lean().cursor();

    for await (const event of cursor) {
      if (
        event.sequence !== expectedSequence ||
        event.previousHash !== previousHash ||
        event.hash !== eventHash(event)
      ) {
        return res.status(409).json({
          valid: false,
          failedAtSequence: event.sequence,
          expectedSequence,
          reason: "Audit chain integrity check failed"
        });
      }
      expectedSequence += 1;
      previousHash = event.hash;
    }

    return res.json({ valid: true, eventCount: expectedSequence - 1, headHash: previousHash });
  } catch (error) {
    return next(error);
  }
});

router.get("/users", requireAdmin, async (req, res, next) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 50);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: "Invalid pagination" });
    }
    const filter = {};
    if (req.query.role) {
      if (!roles.includes(req.query.role)) return res.status(400).json({ error: "Invalid role" });
      filter.role = req.query.role;
    }
    const [users, total, ownedCounts] = await Promise.all([
      User.find(filter).select("name email role active createdAt").sort({ createdAt: -1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
      Document.aggregate([{ $group: { _id: "$ownerId", count: { $sum: 1 } } }])
    ]);
    const ownedByUser = new Map(ownedCounts.map((entry) => [String(entry._id), entry.count]));
    return res.json({
      users: users.map((user) => ({
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role,
        active: user.active,
        createdAt: user.createdAt,
        ownedDocuments: ownedByUser.get(String(user._id)) || 0
      })),
      page,
      limit,
      total
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/users", requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (
      typeof name !== "string" || !name.trim() || name.trim().length > 120 ||
      typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254 ||
      typeof password !== "string" || password.length < 12 ||
      !roles.includes(role)
    ) {
      return res.status(400).json({ error: "Valid name, email, 12+ character password, and role are required" });
    }
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
      role
    });
    await appendAudit({
      actorId: req.user._id,
      action: "user_create",
      outcome: "success",
      details: { targetUserId: user._id, role }
    });
    return res.status(201).json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active }
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "A user with that email already exists" });
    }
    return next(error);
  }
});

router.patch("/users/:id/active", requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || typeof req.body?.active !== "boolean") {
      return res.status(400).json({ error: "Valid user ID and boolean active value are required" });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (user._id.equals(req.user._id) && !req.body.active) {
      return res.status(400).json({ error: "You cannot deactivate your own account" });
    }
    if (user.role === "admin" && user.active && !req.body.active) {
      const activeAdmins = await User.countDocuments({ role: "admin", active: true });
      if (activeAdmins <= 1) {
        return res.status(409).json({ error: "The last active administrator cannot be deactivated" });
      }
    }
    if (user.role === "owner" && user.active && !req.body.active) {
      const ownedDocuments = await Document.countDocuments({ ownerId: user._id, deletedAt: null });
      if (ownedDocuments > 0) {
        return res.status(409).json({ error: "Transfer this user's active documents before deactivation" });
      }
    }
    if (user.active && !req.body.active) {
      const documentsWithGrants = await Document.find({ "grants.userId": user._id, deletedAt: null });
      for (const document of documentsWithGrants) {
        const removedGrant = document.grants.find((grant) => grant.userId.equals(user._id));
        document.grants = document.grants.filter((grant) => !grant.userId.equals(user._id));
        await document.save();
        await appendAudit({
          actorId: req.user._id,
          documentId: document._id,
          action: "permission_revoke",
          outcome: "success",
          details: { targetUserId: user._id, revokedPermission: removedGrant?.permission, reason: "user_deactivated" }
        });
      }
    }
    user.active = req.body.active;
    user.tokenVersion += 1;
    await user.save();
    await appendAudit({
      actorId: req.user._id,
      action: user.active ? "user_activate" : "user_deactivate",
      outcome: "success",
      details: { targetUserId: user._id }
    });
    return res.json({ user: { id: user.id, active: user.active } });
  } catch (error) {
    return next(error);
  }
});

// Thresholds for what an administrator should be told about. Deliberately
// simple and explainable; documented in THREATS.md.
const ALERT_RULES = {
  deniedPerActor24h: 5,
  downloadsPerActor1h: 20,
  failedLoginsPerEmail24h: 5,
  anonymousDenied24h: 25
};

async function usersById(ids) {
  const users = await User.find({ _id: { $in: ids.filter(Boolean) } }).select("name email role active").lean();
  return new Map(users.map((user) => [String(user._id), user]));
}

function personSummary(user, fallbackId) {
  return user
    ? { id: String(user._id), name: user.name, email: user.email, role: user.role }
    : { id: fallbackId ? String(fallbackId) : null, name: fallbackId ? "Unknown account" : "Unauthenticated", email: null };
}

router.get("/overview", requireAdmin, async (req, res, next) => {
  try {
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000);
    const since1h = new Date(now - 60 * 60 * 1000);
    const [
      userCounts,
      documentCount,
      deletedCount,
      actionCounts,
      deniedByActor,
      downloadsByActor,
      failedLogins,
      recentPermissionChanges,
      recentDenied
    ] = await Promise.all([
      User.aggregate([{ $group: { _id: { role: "$role", active: "$active" }, count: { $sum: 1 } } }]),
      Document.countDocuments({ deletedAt: null }),
      Document.countDocuments({ deletedAt: { $ne: null } }),
      AuditEvent.aggregate([
        { $match: { occurredAt: { $gte: since24h } } },
        { $group: { _id: { action: "$action", outcome: "$outcome" }, count: { $sum: 1 } } }
      ]),
      AuditEvent.aggregate([
        { $match: { occurredAt: { $gte: since24h }, outcome: "denied" } },
        { $group: { _id: "$actorId", count: { $sum: 1 }, last: { $max: "$occurredAt" } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      AuditEvent.aggregate([
        { $match: { occurredAt: { $gte: since1h }, action: "download", outcome: "success" } },
        { $group: { _id: "$actorId", count: { $sum: 1 }, documents: { $addToSet: "$documentId" } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      AuditEvent.aggregate([
        { $match: { occurredAt: { $gte: since24h }, action: "access_denied", "details.reason": "invalid_login" } },
        { $group: { _id: "$details.email", count: { $sum: 1 }, last: { $max: "$occurredAt" } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      AuditEvent.find({ action: { $in: ["permission_grant", "permission_revoke", "ownership_transfer"] } })
        .populate("actorId", "name email")
        .sort({ sequence: -1 })
        .limit(10)
        .lean(),
      AuditEvent.find({ outcome: "denied" })
        .populate("actorId", "name email")
        .sort({ sequence: -1 })
        .limit(10)
        .lean()
    ]);

    const people = await usersById([
      ...deniedByActor.map((entry) => entry._id),
      ...downloadsByActor.map((entry) => entry._id),
      ...recentPermissionChanges.map((event) => event.details?.targetUserId)
    ]);

    const alerts = [];
    for (const entry of deniedByActor) {
      if (entry._id && entry.count >= ALERT_RULES.deniedPerActor24h) {
        alerts.push({
          severity: entry.count >= ALERT_RULES.deniedPerActor24h * 3 ? "high" : "medium",
          title: "Repeated refused requests",
          description: `${personSummary(people.get(String(entry._id)), entry._id).name} was refused ${entry.count} times in the last 24 hours.`,
          actorId: String(entry._id),
          occurredAt: entry.last
        });
      }
      if (!entry._id && entry.count >= ALERT_RULES.anonymousDenied24h) {
        alerts.push({
          severity: "medium",
          title: "Many unauthenticated requests",
          description: `${entry.count} requests without a valid session were refused in the last 24 hours.`,
          occurredAt: entry.last
        });
      }
    }
    for (const entry of downloadsByActor) {
      if (entry._id && entry.count >= ALERT_RULES.downloadsPerActor1h) {
        alerts.push({
          severity: "high",
          title: "Unusual download volume",
          description: `${personSummary(people.get(String(entry._id)), entry._id).name} downloaded ${entry.count} files (${entry.documents.length} documents) in the last hour.`,
          actorId: String(entry._id)
        });
      }
    }
    for (const entry of failedLogins) {
      if (entry.count >= ALERT_RULES.failedLoginsPerEmail24h) {
        alerts.push({
          severity: "medium",
          title: "Possible password guessing",
          description: `${entry.count} failed sign-ins for ${entry._id || "an empty email"} in the last 24 hours.`,
          occurredAt: entry.last
        });
      }
    }

    const counts = (action, outcome) => actionCounts
      .filter((entry) => entry._id.action === action && (!outcome || entry._id.outcome === outcome))
      .reduce((sum, entry) => sum + entry.count, 0);

    return res.json({
      users: {
        total: userCounts.reduce((sum, entry) => sum + entry.count, 0),
        active: userCounts.filter((entry) => entry._id.active).reduce((sum, entry) => sum + entry.count, 0),
        byRole: Object.fromEntries(roles.map((role) => [
          role,
          userCounts.filter((entry) => entry._id.role === role).reduce((sum, entry) => sum + entry.count, 0)
        ]))
      },
      documents: { active: documentCount, deleted: deletedCount },
      last24h: {
        uploads: counts("upload", "success"),
        downloads: counts("download", "success"),
        reads: counts("read", "success"),
        denied: actionCounts.filter((entry) => entry._id.outcome === "denied").reduce((sum, entry) => sum + entry.count, 0),
        permissionChanges: counts("permission_grant") + counts("permission_revoke")
      },
      alerts,
      rules: ALERT_RULES,
      topDenied: deniedByActor.map((entry) => ({
        actor: personSummary(people.get(String(entry._id)), entry._id),
        count: entry.count,
        last: entry.last
      })),
      recentPermissionChanges: recentPermissionChanges.map((event) => ({
        sequence: event.sequence,
        action: event.action,
        occurredAt: event.occurredAt,
        actor: event.actorId ? { name: event.actorId.name, email: event.actorId.email } : null,
        // Admins see document IDs, not names: names like "J. Smith salary letter" are themselves confidential.
        documentId: event.documentId ? String(event.documentId) : null,
        target: event.details?.targetUserId
          ? personSummary(people.get(String(event.details.targetUserId)), event.details.targetUserId)
          : null,
        permission: event.details?.permission || event.details?.revokedPermission || null,
        expiresAt: event.details?.expiresAt || null,
        source: event.details?.source || null
      })),
      recentDenied: recentDenied.map((event) => ({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        actor: event.actorId ? { name: event.actorId.name, email: event.actorId.email } : null,
        reason: event.details?.reason || null,
        path: event.details?.path || null
      }))
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/users/:id/password", requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!mongoose.isValidObjectId(req.params.id) || typeof password !== "string" || password.length < 12 || password.length > 200) {
      return res.status(400).json({ error: "Valid user ID and a 12+ character password are required" });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.passwordHash = await bcrypt.hash(password, 12);
    user.tokenVersion += 1;
    await user.save();
    await appendAudit({
      actorId: req.user._id,
      action: "password_reset",
      outcome: "success",
      details: { targetUserId: user._id }
    });
    return res.json({ user: { id: String(user._id) } });
  } catch (error) {
    return next(error);
  }
});

// Offboarding: hands every document (including ones in trash) to another
// owner without the administrator ever seeing document names or contents.
router.post("/users/:id/transfer-documents", requireAdmin, async (req, res, next) => {
  try {
    const { toUserId } = req.body || {};
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(toUserId)) {
      return res.status(400).json({ error: "Valid source user ID and toUserId are required" });
    }
    if (String(req.params.id) === String(toUserId)) {
      return res.status(400).json({ error: "Choose a different owner to receive the documents" });
    }
    const [fromUser, toUser] = await Promise.all([
      User.findById(req.params.id).select("_id"),
      User.findOne({ _id: toUserId, role: "owner", active: true }).select("_id")
    ]);
    if (!fromUser) return res.status(404).json({ error: "User not found" });
    if (!toUser) return res.status(404).json({ error: "Active document owner not found" });

    const documents = await Document.find({ ownerId: fromUser._id });
    for (const document of documents) {
      document.ownerId = toUser._id;
      document.grants = document.grants.filter(
        (grant) => !grant.userId.equals(toUser._id) && !grant.userId.equals(fromUser._id)
      );
      await document.save();
      await appendAudit({
        actorId: req.user._id,
        documentId: document._id,
        action: "ownership_transfer",
        outcome: "success",
        details: { previousOwnerId: fromUser._id, newOwnerId: toUser._id, reason: "bulk_transfer" }
      });
    }
    return res.json({ transferred: documents.length });
  } catch (error) {
    return next(error);
  }
});

router.put("/documents/:id/owner", requireAdmin, async (req, res, next) => {
  try {
    const { ownerId } = req.body || {};
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(ownerId)) {
      return res.status(400).json({ error: "Valid document ID and ownerId are required" });
    }
    const [document, newOwner] = await Promise.all([
      Document.findOne({ _id: req.params.id, deletedAt: null }),
      User.findOne({ _id: ownerId, role: "owner", active: true }).select("_id")
    ]);
    if (!document) return res.status(404).json({ error: "Document not found" });
    if (!newOwner) return res.status(404).json({ error: "Active document owner not found" });
    const previousOwnerId = document.ownerId;
    if (previousOwnerId.equals(newOwner._id)) {
      return res.status(400).json({ error: "That user already owns the document" });
    }
    document.ownerId = newOwner._id;
    document.grants = document.grants.filter(
      (grant) => !grant.userId.equals(newOwner._id) && !grant.userId.equals(previousOwnerId)
    );
    await document.save();
    await appendAudit({
      actorId: req.user._id,
      documentId: document._id,
      action: "ownership_transfer",
      outcome: "success",
      details: { previousOwnerId, newOwnerId: newOwner._id }
    });
    return res.json({ documentId: document.id, ownerId: newOwner.id });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
