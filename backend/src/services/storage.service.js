const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { storageDir } = require("../config/env");

const absoluteStorageDir = path.resolve(storageDir);

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

async function ensureStorageDirectory() {
  await fs.mkdir(absoluteStorageDir, { recursive: true, mode: 0o700 });
}

async function saveFile(buffer) {
  await ensureStorageDirectory();
  const storageKey = crypto.randomUUID();
  const filePath = path.join(absoluteStorageDir, storageKey);
  await fs.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
  return storageKey;
}

function getFilePath(storageKey) {
  if (!/^[0-9a-f-]{36}$/i.test(storageKey)) {
    throw new Error("Invalid storage key");
  }
  const filePath = path.resolve(absoluteStorageDir, storageKey);
  if (path.dirname(filePath) !== absoluteStorageDir) {
    throw new Error("Invalid storage key");
  }
  return filePath;
}

async function removeFile(storageKey) {
  await fs.rm(getFilePath(storageKey), { force: true });
}

module.exports = { detectFileType, saveFile, getFilePath, removeFile };
