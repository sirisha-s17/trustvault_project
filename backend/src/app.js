const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const path = require("path");
const authRoutes = require("./routes/auth.routes");
const documentRoutes = require("./routes/document.routes");
const healthRoutes = require("./routes/health.routes");
const adminRoutes = require("./routes/admin.routes");
const userRoutes = require("./routes/user.routes");
const errorHandler = require("./middleware/errorHandler");
const trustedOrigin = require("./middleware/trustedOrigin");
const rateLimit = require("express-rate-limit");
const { clientOrigin, trustProxy } = require("./config/env");

const app = express();

app.set("trust proxy", trustProxy);
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin === clientOrigin) {
    res.setHeader("Access-Control-Allow-Origin", clientOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    if (origin !== clientOrigin) {
      return res.status(403).json({ error: "Untrusted request origin" });
    }
    return res.status(204).end();
  }
  return next();
});

app.use(trustedOrigin);

// Every refused request writes an audit event, so cap per-IP volume to stop
// anyone flooding the audit trail (or the database) with junk.
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false
}));

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/admin", adminRoutes);

app.use(express.static(path.join(__dirname, "..", "..", "frontend"), {
  index: "index.html",
  dotfiles: "deny",
  fallthrough: true,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-cache");
  }
}));

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});
app.use(errorHandler);

module.exports = app;
