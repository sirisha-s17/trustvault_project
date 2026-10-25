const app = require("./app");
const connectDatabase = require("./config/database");
const { port } = require("./config/env");

async function startServer() {
  await connectDatabase();
  app.listen(port, () => {
    console.log(`TrustVault API listening on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start TrustVault API", error);
  process.exitCode = 1;
});
