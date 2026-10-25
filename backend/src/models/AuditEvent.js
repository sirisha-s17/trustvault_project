const mongoose = require("mongoose");

const auditEventSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      default: null,
      index: true
    },
    sequence: {
      type: Number,
      required: true,
      unique: true,
      immutable: true
    },
    action: {
      type: String,
      enum: [
        "login",
        "logout",
        "upload",
        "read",
        "download",
        "edit",
        "delete",
        "permission_grant",
        "permission_revoke",
        "access_denied",
        "search",
        "user_create",
        "user_deactivate",
        "user_activate",
        "ownership_transfer",
        "restore",
        "version_upload",
        "access_suggestion",
        "password_change",
        "password_reset"
      ],
      required: true
    },
    outcome: {
      type: String,
      enum: ["success", "denied", "failure"],
      required: true
    },
    occurredAt: {
      type: Date,
      default: Date.now,
      required: true,
      immutable: true
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
      immutable: true
    },
    previousHash: {
      type: String,
      required: true,
      immutable: true
    },
    hash: {
      type: String,
      required: true,
      immutable: true
    }
  },
  {
    timestamps: false,
    versionKey: false
  }
);

auditEventSchema.index({ occurredAt: -1 });
auditEventSchema.index({ action: 1, occurredAt: -1 });

for (const operation of ["updateOne", "updateMany", "findOneAndUpdate", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  auditEventSchema.pre(operation, function preventAuditMutation() {
    throw new Error("Audit events are append-only");
  });
}
auditEventSchema.pre("save", function preventAuditSaveMutation() {
  if (!this.isNew) {
    throw new Error("Audit events are append-only");
  }
});
for (const operation of ["replaceOne", "findOneAndReplace"]) {
  auditEventSchema.pre(operation, function preventAuditReplacement() {
    throw new Error("Audit events are append-only");
  });
}

module.exports = mongoose.model("AuditEvent", auditEventSchema);
