const crypto = require("crypto");
const AuditEvent = require("../models/AuditEvent");

function canonicalize(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value.toHexString === "function") {
    return value.toHexString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function eventHash(event) {
  const payload = {
    sequence: event.sequence,
    actorId: event.actorId || null,
    documentId: event.documentId || null,
    action: event.action,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
    details: event.details || {},
    previousHash: event.previousHash
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}

async function appendAudit(input) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const previous = await AuditEvent.findOne().sort({ sequence: -1 }).lean();
    const event = {
      actorId: input.actorId || null,
      documentId: input.documentId || null,
      action: input.action,
      outcome: input.outcome,
      occurredAt: new Date(),
      details: input.details || {},
      sequence: previous ? previous.sequence + 1 : 1,
      previousHash: previous ? previous.hash : "0".repeat(64)
    };
    event.hash = eventHash(event);

    try {
      return await AuditEvent.create(event);
    } catch (error) {
      if (error.code !== 11000 || attempt === 4) {
        throw error;
      }
    }
  }

  throw new Error("Could not append audit event");
}

module.exports = appendAudit;
module.exports.eventHash = eventHash;
