function errorHandler(error, req, res, next) {
  console.error(error);

  if (res.headersSent) {
    return next(error);
  }

  if (error.name === "MulterError") {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: status === 413 ? "Uploaded file is too large" : "Invalid upload"
    });
  }
  if (error.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Malformed JSON request body" });
  }
  if (error.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large" });
  }
  if (error.name === "ValidationError" || error.name === "CastError") {
    return res.status(400).json({ error: "Invalid request data" });
  }

  return res.status(500).json({ error: "Internal server error" });
}

module.exports = errorHandler;
