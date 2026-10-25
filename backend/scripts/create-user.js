require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const User = require("../src/models/User");

const roles = ["admin", "owner", "viewer"];

async function createUser() {
  const { MONGODB_URI, USER_NAME, USER_EMAIL, USER_PASSWORD, USER_ROLE } = process.env;
  const role = USER_ROLE || "viewer";

  if (!MONGODB_URI || !USER_NAME || !USER_EMAIL || !USER_PASSWORD) {
    throw new Error("Set MONGODB_URI, USER_NAME, USER_EMAIL, and USER_PASSWORD before running");
  }
  if (!roles.includes(role)) {
    throw new Error(`USER_ROLE must be one of: ${roles.join(", ")}`);
  }
  if (USER_PASSWORD.length < 12) {
    throw new Error("USER_PASSWORD must be at least 12 characters long");
  }

  await mongoose.connect(MONGODB_URI);
  const email = USER_EMAIL.trim().toLowerCase();
  const existingUser = await User.exists({ email });
  if (existingUser) {
    throw new Error(`A user with email ${email} already exists`);
  }

  const passwordHash = await bcrypt.hash(USER_PASSWORD, 12);
  await User.create({ name: USER_NAME.trim(), email, passwordHash, role });
  console.log(`Created ${role} user: ${email}`);
}

createUser()
  .catch((error) => {
    console.error("Failed to create user", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });
