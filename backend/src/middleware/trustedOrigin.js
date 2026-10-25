const { clientOrigin } = require("../config/env");
const appendAudit = require("../services/audit.service");

async function trustedOrigin(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }

  if (req.get("origin") !== clientOrigin) {
    try {
      await appendAudit({
        action: "access_denied",
        outcome: "denied",
        details: { reason: "untrusted_origin", path: req.originalUrl }
      });
      return res.status(403).json({ error: "Untrusted request origin" });
    } catch (error) {
      return next(error);
    }
  }

  return next();
}

module.exports = trustedOrigin;
