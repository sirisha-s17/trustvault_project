// Creates one account per role plus realistic demo documents and grants.
// Safe to re-run: existing users and documents (same owner + name) are skipped.
// Usage: npm run seed
const crypto = require("crypto");
const zlib = require("zlib");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const connectDatabase = require("../src/config/database");
const Document = require("../src/models/Document");
const User = require("../src/models/User");
const appendAudit = require("../src/services/audit.service");
const storage = require("../src/services/storage.service");

const DAY = 24 * 60 * 60 * 1000;

const seedUsers = [
  { key: "admin", name: "Alex Admin", email: "admin@trustvault.demo", password: "Admin@Vault2026!", role: "admin" },
  { key: "olivia", name: "Olivia Owner (HR)", email: "olivia.owner@trustvault.demo", password: "Owner@Vault2026!", role: "owner" },
  { key: "marcus", name: "Marcus Owner (Legal)", email: "marcus.owner@trustvault.demo", password: "Owner2@Vault2026!", role: "owner" },
  { key: "victor", name: "Victor Viewer (Employee)", email: "victor.viewer@trustvault.demo", password: "Viewer@Vault2026!", role: "viewer" },
  { key: "priya", name: "Priya Viewer (External partner)", email: "priya.viewer@trustvault.demo", password: "Viewer2@Vault2026!", role: "viewer" }
];

function makePdf(title, lines) {
  const escapePdf = (text) => text.replace(/[\\()]/g, "\\$&");
  const content = [
    "BT /F1 20 Tf 60 760 Td",
    `(${escapePdf(title)}) Tj`,
    "/F1 11 Tf 0 -34 Td 16 TL",
    ...lines.map((line) => `(${escapePdf(line)}) '`),
    "ET"
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

function makePng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", pixels),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const seedDocuments = [
  {
    owner: "olivia",
    name: "Victor Salary Letter 2026",
    category: "HR",
    file: () => makePdf("Salary letter - Victor Viewer", ["Effective 1 January 2026.", "Annual base salary: 72,000.", "Confidential: addressee only."]),
    mimeType: "application/pdf",
    grants: [{ to: "victor", permission: "read" }]
  },
  {
    owner: "olivia",
    name: "Employee Handbook",
    category: "HR",
    file: () => makePdf("Employee Handbook v1", ["1. Working hours", "2. Leave policy", "3. Code of conduct"]),
    secondVersion: () => makePdf("Employee Handbook v2", ["1. Working hours", "2. Leave policy (updated)", "3. Code of conduct", "4. Remote work"]),
    mimeType: "application/pdf",
    grants: [{ to: "victor", permission: "read" }, { to: "marcus", permission: "edit" }]
  },
  {
    owner: "olivia",
    name: "Performance Review Notes",
    category: "HR",
    file: () => Buffer.from("Performance review notes\n\nStrengths: delivery, ownership.\nGoals: mentoring.\n", "utf8"),
    mimeType: "text/plain",
    grants: []
  },
  {
    owner: "olivia",
    name: "Old Org Chart",
    category: "HR",
    file: () => makePng(64, 40, [99, 91, 219]),
    mimeType: "image/png",
    grants: [],
    deleted: true
  },
  {
    owner: "marcus",
    name: "Partner NDA - Priya Consulting",
    category: "Contracts",
    file: () => makePdf("Mutual Non-Disclosure Agreement", ["Between TrustVault Ltd and Priya Consulting.", "Term: 2 years.", "Governing law: England and Wales."]),
    mimeType: "application/pdf",
    grants: [{ to: "priya", permission: "read", expiresInDays: 14 }]
  },
  {
    owner: "marcus",
    name: "Supplier Contract Draft",
    category: "Contracts",
    file: () => makePdf("Supplier Agreement - DRAFT", ["Clause 4: payment within 30 days.", "Clause 9: liability cap."]),
    mimeType: "application/pdf",
    grants: [{ to: "olivia", permission: "edit" }]
  },
  {
    owner: "marcus",
    name: "Site Drawing - Building B",
    category: "Drawings",
    file: () => makePng(120, 80, [33, 132, 111]),
    mimeType: "image/png",
    grants: [{ to: "priya", permission: "read", expiresInDays: 7 }]
  },
  {
    owner: "marcus",
    name: "Audit Evidence Index",
    category: "Audit",
    file: () => Buffer.from("Audit evidence index FY2025\n\nA1 Bank reconciliations\nA2 Payroll sample\nA3 Contracts register\n", "utf8"),
    mimeType: "text/plain",
    grants: []
  }
];

async function ensureUsers() {
  const byKey = {};
  for (const seed of seedUsers) {
    const email = seed.email.toLowerCase();
    let user = await User.findOne({ email });
    if (user) {
      console.log(`  user exists   ${email}`);
    } else {
      user = await User.create({
        name: seed.name,
        email,
        passwordHash: await bcrypt.hash(seed.password, 12),
        role: seed.role
      });
      await appendAudit({ action: "user_create", outcome: "success", details: { targetUserId: user._id, role: seed.role, via: "seed" } });
      console.log(`  user created  ${email}`);
    }
    byKey[seed.key] = user;
  }
  return byKey;
}

async function storeFile(buffer, mimeType) {
  const storageKey = await storage.saveFile(buffer);
  return {
    storageKey,
    mimeType,
    sizeBytes: buffer.length,
    checksumSha256: crypto.createHash("sha256").update(buffer).digest("hex")
  };
}

async function ensureDocuments(users) {
  for (const seed of seedDocuments) {
    const owner = users[seed.owner];
    if (await Document.exists({ ownerId: owner._id, name: seed.name })) {
      console.log(`  doc exists    ${seed.name}`);
      continue;
    }
    const first = await storeFile(seed.file(), seed.mimeType);
    if (!storage.detectFileType(seed.file(), { "application/pdf": ".pdf", "image/png": ".png", "text/plain": ".txt" }[seed.mimeType])) {
      throw new Error(`Seed file for ${seed.name} fails validation`);
    }
    const document = await Document.create({
      name: seed.name,
      category: seed.category,
      ownerId: owner._id,
      ...first,
      uploadedBy: owner._id,
      fileUploadedAt: new Date()
    });
    await appendAudit({
      actorId: owner._id,
      documentId: document._id,
      action: "upload",
      outcome: "success",
      details: { name: seed.name, category: seed.category, mimeType: first.mimeType, sizeBytes: first.sizeBytes, checksumSha256: first.checksumSha256, via: "seed" }
    });

    if (seed.secondVersion) {
      const doc = await Document.findById(document._id).select("+storageKey +versions");
      const next = await storeFile(seed.secondVersion(), seed.mimeType);
      doc.versions.push({
        version: 1,
        storageKey: doc.storageKey,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        checksumSha256: doc.checksumSha256,
        uploadedBy: owner._id,
        uploadedAt: doc.fileUploadedAt
      });
      Object.assign(doc, next, { currentVersion: 2, uploadedBy: owner._id, fileUploadedAt: new Date() });
      await doc.save();
      await appendAudit({
        actorId: owner._id,
        documentId: doc._id,
        action: "version_upload",
        outcome: "success",
        details: { version: 2, previousVersion: 1, mimeType: next.mimeType, sizeBytes: next.sizeBytes, checksumSha256: next.checksumSha256, via: "seed" }
      });
    }

    for (const grant of seed.grants) {
      const target = users[grant.to];
      const expiresAt = grant.expiresInDays ? new Date(Date.now() + grant.expiresInDays * DAY) : null;
      await Document.updateOne(
        { _id: document._id },
        { $push: { grants: { userId: target._id, permission: grant.permission, grantedBy: owner._id, grantedAt: new Date(), expiresAt } } }
      );
      await appendAudit({
        actorId: owner._id,
        documentId: document._id,
        action: "permission_grant",
        outcome: "success",
        details: { targetUserId: target._id, targetEmail: target.email, permission: grant.permission, previousPermission: null, expiresAt, source: "manual", via: "seed" }
      });
    }

    if (seed.deleted) {
      await Document.updateOne({ _id: document._id }, { deletedAt: new Date(), deletedBy: owner._id });
      await appendAudit({ actorId: owner._id, documentId: document._id, action: "delete", outcome: "success", details: { name: seed.name, via: "seed" } });
    }
    console.log(`  doc created   ${seed.name}`);
  }
}

async function seed() {
  await connectDatabase();
  console.log("Seeding users");
  const users = await ensureUsers();
  console.log("Seeding documents");
  await ensureDocuments(users);
  console.log("\nDemo accounts:");
  for (const user of seedUsers) {
    console.log(`  ${user.role.padEnd(6)}  ${user.email.padEnd(32)}  ${user.password}`);
  }
}

seed()
  .catch((error) => {
    console.error("Seeding failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
