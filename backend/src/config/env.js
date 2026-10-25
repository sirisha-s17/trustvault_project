const dotenv = require("dotenv");

dotenv.config();

const required = ["MONGODB_URI", "JWT_SECRET"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) {
  throw new Error("MAX_UPLOAD_BYTES must be a positive integer");
}

// Number of reverse proxies in front of the API (e.g. 1 on Render/Railway/Heroku).
// Without this, every client shares the proxy's IP and rate limits become global.
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (!Number.isSafeInteger(trustProxy) || trustProxy < 0) {
  throw new Error("TRUST_PROXY must be a non-negative integer");
}

// "disk" (default) or "gridfs" (store files in MongoDB, for hosts without a persistent disk).
const storageDriver = process.env.STORAGE_DRIVER || "disk";
if (!["disk", "gridfs"].includes(storageDriver)) {
  throw new Error("STORAGE_DRIVER must be disk or gridfs");
}

module.exports = {
  trustProxy,
  storageDriver,
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || "development",
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  storageDir: process.env.STORAGE_DIR || "./private-storage",
  maxUploadBytes
};
