const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { storageDir, storageDriver } = require("../config/env");

// Files are stored under a random UUID, never under a user-supplied name, in
// one of two private places:
//   disk   - a directory outside the web root (default; local development)
//   gridfs - MongoDB GridFS, for hosts whose disk is wiped on restart (Render free)
// Neither is reachable over HTTP except through the authorised download routes.

const absoluteStorageDir = path.resolve(storageDir);
const STORAGE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function detectFileType(buffer, extension) {
  const signatures = {
    ".pdf": {
      mimeType: "application/pdf",
      matches: (data) => data.length >= 5 && data.subarray(0, 5).toString() === "%PDF-"
    },
    ".png": {
      mimeType: "image/png",
      matches: (data) =>
        data.length >= 8 &&
        data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    },
    ".jpg": {
      mimeType: "image/jpeg",
      matches: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    },
    ".jpeg": {
      mimeType: "image/jpeg",
      matches: (data) => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    },
    ".txt": {
      mimeType: "text/plain",
      matches: (data) => {
        if (data.includes(0)) {
          return false;
        }
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(data);
          return true;
        } catch {
          return false;
        }
      }
    }
  };
  const type = signatures[extension];
  return type && type.matches(buffer) ? type.mimeType : null;
}

function assertStorageKey(storageKey) {
  if (typeof storageKey !== "string" || !STORAGE_KEY_PATTERN.test(storageKey)) {
    throw new Error("Invalid storage key");
  }
}

/* ---------- disk ---------- */

function getFilePath(storageKey) {
  assertStorageKey(storageKey);
  const filePath = path.resolve(absoluteStorageDir, storageKey);
  if (path.dirname(filePath) !== absoluteStorageDir) {
    throw new Error("Invalid storage key");
  }
  return filePath;
}

const diskDriver = {
  async save(storageKey, buffer) {
    await fs.promises.mkdir(absoluteStorageDir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(getFilePath(storageKey), buffer, { flag: "wx", mode: 0o600 });
  },
  async open(storageKey) {
    const filePath = getFilePath(storageKey);
    const stat = await fs.promises.stat(filePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return stat ? { sizeBytes: stat.size, createStream: () => fs.createReadStream(filePath) } : null;
  },
  async remove(storageKey) {
    await fs.promises.rm(getFilePath(storageKey), { force: true });
  }
};

/* ---------- gridfs ---------- */

function bucket() {
  if (!mongoose.connection.db) {
    throw new Error("GridFS storage needs an open MongoDB connection");
  }
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "documentFiles" });
}

const gridfsDriver = {
  async save(storageKey, buffer) {
    assertStorageKey(storageKey);
    await new Promise((resolve, reject) => {
      const upload = bucket().openUploadStream(storageKey);
      upload.once("finish", resolve);
      upload.once("error", reject);
      upload.end(buffer);
    });
  },
  async open(storageKey) {
    assertStorageKey(storageKey);
    const files = bucket();
    const [file] = await files.find({ filename: storageKey }).limit(1).toArray();
    return file ? { sizeBytes: file.length, createStream: () => files.openDownloadStream(file._id) } : null;
  },
  async remove(storageKey) {
    assertStorageKey(storageKey);
    const files = bucket();
    for (const file of await files.find({ filename: storageKey }).toArray()) {
      await files.delete(file._id);
    }
  }
};

const driver = storageDriver === "gridfs" ? gridfsDriver : diskDriver;

async function saveFile(buffer) {
  const storageKey = crypto.randomUUID();
  await driver.save(storageKey, buffer);
  return storageKey;
}

// Returns { sizeBytes, createStream } or null when the stored file is missing.
function openFile(storageKey) {
  return driver.open(storageKey);
}

function removeFile(storageKey) {
  return driver.remove(storageKey);
}

module.exports = { detectFileType, saveFile, openFile, removeFile, getFilePath };
