const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authenticate = require("../middleware/authenticate");
const { jwtSecret, jwtExpiresIn, nodeEnv } = require("../config/env");
const rateLimit = require("express-rate-limit");
const appendAudit = require("../services/audit.service");

const router = express.Router();
const cookieOptions = {
  httpOnly: true,
  secure: nodeEnv === "production",
  sameSite: nodeEnv === "production" ? "none" : "lax",
  path: "/"
};
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false
});

function issueSessionCookie(res, user) {
  const token = jwt.sign({ sub: String(user._id), ver: user.tokenVersion }, jwtSecret, { expiresIn: jwtExpiresIn });
  // Cookie lifetime follows the JWT's own expiry so JWT_EXPIRES_IN is the single source of truth.
  res.cookie("trustvault_token", token, {
    ...cookieOptions,
    maxAge: jwt.decode(token).exp * 1000 - Date.now()
  });
}

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
      await appendAudit({
        action: "access_denied",
        outcome: "denied",
        details: { reason: "invalid_login", email }
      });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    issueSessionCookie(res, user);
    await appendAudit({
      actorId: user._id,
      action: "login",
      outcome: "success"
    });

    return res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", authenticate, async (req, res, next) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    await appendAudit({
      actorId: req.user._id,
      action: "logout",
      outcome: "success"
    });
  } catch (error) {
    return next(error);
  }
  res.clearCookie("trustvault_token", cookieOptions);
  return res.status(204).end();
});

router.post("/password", authenticate, loginLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 200) {
      return res.status(400).json({ error: "Current password and a new 12+ character password are required" });
    }
    const user = await User.findById(req.user._id).select("+passwordHash");
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      await appendAudit({
        actorId: user._id,
        action: "password_change",
        outcome: "denied",
        details: { reason: "wrong_current_password" }
      });
      return res.status(400).json({ error: "Current password is incorrect" });
    }
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    // Ends every other session; this one gets a fresh token below.
    user.tokenVersion += 1;
    await user.save();
    await appendAudit({ actorId: user._id, action: "password_change", outcome: "success" });
    issueSessionCookie(res, user);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

router.get("/me", authenticate, (req, res) => {
  return res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role
    }
  });
});

module.exports = router;
