const mongoose = require("mongoose");

const grantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    permission: {
      type: String,
      enum: ["read", "edit"],
      required: true
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    grantedAt: {
      type: Date,
      default: Date.now,
      required: true
    },
    // Optional end of access, e.g. for external partners. Checked on every request.
    expiresAt: {
      type: Date,
      default: null
    }
  },
  { _id: false }
);

// Previous file contents. The current file lives in the top-level fields.
const versionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, min: 1 },
    storageKey: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    checksumSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    uploadedAt: { type: Date, required: true }
  },
  { _id: false }
);

const documentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255
    },
    category: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "Uncategorized"
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    grants: {
      type: [grantSchema],
      default: []
    },
    storageKey: {
      type: String,
      required: true,
      select: false
    },
    mimeType: {
      type: String,
      required: true
    },
    checksumSha256: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1
    },
    currentVersion: {
      type: Number,
      default: 1,
      min: 1
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    fileUploadedAt: {
      type: Date,
      default: Date.now
    },
    versions: {
      type: [versionSchema],
      default: [],
      select: false
    },
    deletedAt: {
      type: Date,
      default: null
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null
    }
  },
  { timestamps: true }
);

documentSchema.index({ name: "text", category: "text" });
documentSchema.index({ ownerId: 1, createdAt: -1 });
documentSchema.index({ "grants.userId": 1, createdAt: -1 });

module.exports = mongoose.model("Document", documentSchema);
