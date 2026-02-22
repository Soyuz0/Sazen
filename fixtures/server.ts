import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";

const root = resolve("fixtures/sample-app");
const port = 4173;

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const server = createServer(async (req, res) => {
  const requestPath = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
  const filePath = resolve(root, `.${requestPath}`);

  if (!filePath.startsWith(root)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  try {
    await access(filePath);
    const ext = extname(filePath).toLowerCase();
    res.setHeader("content-type", mimeTypes[ext] ?? "application/octet-stream");
    createReadStream(filePath).pipe(res);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`Not found: ${join("fixtures/sample-app", requestPath)}`);
  }
});

server.listen(port, () => {
  console.log(`Fixture server running at http://localhost:${port}`);
});
