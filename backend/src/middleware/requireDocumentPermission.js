const mongoose = require("mongoose");
const Document = require("../models/Document");
const appendAudit = require("../services/audit.service");
const { hasPermission } = require("../services/access.service");

function requireDocumentPermission(requiredPermission, { withVersions = false } = {}) {
  if (!["read", "edit"].includes(requiredPermission)) {
    throw new Error(`Unsupported document permission: ${requiredPermission}`);
  }

  return async function documentPermissionMiddleware(req, res, next) {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        await appendAudit({
          actorId: req.user._id,
          action: "access_denied",
          outcome: "denied",
          details: {
            reason: "invalid_document_id",
            requestedPermission: requiredPermission,
            path: req.originalUrl
          }
        });
        return res.status(404).json({ error: "Document not found" });
      }

      const document = await Document.findOne({
        _id: req.params.id,
        deletedAt: null
      }).select(withVersions ? "+storageKey +versions" : "+storageKey");

      if (!document || !hasPermission(document, req.user, requiredPermission)) {
        await appendAudit({
          actorId: req.user._id,
          documentId: document?._id || null,
          action: "access_denied",
          outcome: "denied",
          details: {
            reason: document ? "permission_denied" : "document_not_found",
            requestedPermission: requiredPermission,
            requestedDocumentId: req.params.id,
            path: req.originalUrl
          }
        });
        return res.status(404).json({ error: "Document not found" });
      }

      req.document = document;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = requireDocumentPermission;
