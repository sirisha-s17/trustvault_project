const express = require("express");
const rateLimit = require("express-rate-limit");
const authenticate = require("../middleware/authenticate");
const User = require("../models/User");
const appendAudit = require("../services/audit.service");

const router = express.Router();
const lookupLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

router.get("/lookup", authenticate, lookupLimiter, async (req, res, next) => {
  try {
    if (req.user.role !== "owner") {
      await appendAudit({
        actorId: req.user._id,
        action: "access_denied",
        outcome: "denied",
        details: { reason: "owner_role_required", path: req.originalUrl }
      });
      return res.status(403).json({ error: "Only document owners may look up people to share with" });
    }
    const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid exact email address is required" });
    }
    const user = await User.findOne({ email, active: true }).select("name email role");
    await appendAudit({
      actorId: req.user._id,
      action: "search",
      outcome: "success",
      details: { searchType: "user_email_lookup", found: Boolean(user) }
    });
    return res.json({
      user: user ? { id: user.id, name: user.name, email: user.email, role: user.role } : null
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
