const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.FRONTEND_PORT || 5173);
const allowedFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/config.js", ["config.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const file = allowedFiles.get(pathname);
  if (!file || req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const filePath = path.join(root, file[0]);
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Could not load frontend asset");
      return;
    }
    res.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": pathname === "/config.js" ? "no-store" : "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  });
});

server.listen(port, () => {
  console.log(`TrustVault frontend listening at http://localhost:${port}`);
});
