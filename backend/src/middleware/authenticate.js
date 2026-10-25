const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { jwtSecret } = require("../config/env");
const appendAudit = require("../services/audit.service");

async function authenticate(req, res, next) {
  try {
    const token = req.cookies?.trustvault_token;
    if (!token) {
      // The frontend asks /auth/me on every page load to see whether a session
      // exists. With no cookie at all that is not an attempt on anything, and
      // auditing it would bury real refusals. Every other route is still audited.
      if (req.originalUrl === "/api/auth/me") {
        return res.status(401).json({ error: "Authentication required" });
      }
      await appendAudit({
        action: "access_denied",
        outcome: "denied",
        details: { reason: "missing_authentication", path: req.originalUrl }
      });
      return res.status(401).json({ error: "Authentication required" });
    }

    const payload = jwt.verify(token, jwtSecret);
    const user = await User.findById(payload.sub).select("_id name email role active tokenVersion");

    if (!user || !user.active || user.tokenVersion !== payload.ver) {
      await appendAudit({
        action: "access_denied",
        outcome: "denied",
        details: { reason: "inactive_or_missing_user", path: req.originalUrl }
      });
      return res.status(401).json({ error: "Authentication required" });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      try {
        await appendAudit({
          action: "access_denied",
          outcome: "denied",
          details: { reason: "invalid_or_expired_token", path: req.originalUrl }
        });
        return res.status(401).json({ error: "Authentication required" });
      } catch (auditError) {
        return next(auditError);
      }
    }
    return next(error);
  }
}

module.exports = authenticate;
