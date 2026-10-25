const test = require("node:test");
const assert = require("node:assert/strict");
const { detectFileType } = require("../src/services/storage.service");

test("file content signatures must match the extension allowlist", () => {
  assert.equal(detectFileType(Buffer.from("%PDF-1.7"), ".pdf"), "application/pdf");
  assert.equal(detectFileType(Buffer.from("%PDF-1.7"), ".png"), null);
  assert.equal(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ".png"), "image/png");
  assert.equal(detectFileType(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), ".jpg"), "image/jpeg");
  assert.equal(detectFileType(Buffer.from([0xff, 0x00]), ".txt"), null);
  assert.equal(detectFileType(Buffer.from("Hello TrustVault", "utf8"), ".txt"), "text/plain");
  assert.equal(detectFileType(Buffer.from("anything"), ".exe"), null);
});
