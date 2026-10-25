const mongoose = require("mongoose");
const { mongoUri } = require("./env");
const User = require("../models/User");
const Document = require("../models/Document");
const AuditEvent = require("../models/AuditEvent");

async function connectDatabase() {
  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10000
  });
  await Promise.all([User.init(), Document.init(), AuditEvent.init()]);
  console.log("Connected to MongoDB");
}

module.exports = connectDatabase;
