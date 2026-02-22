import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";

const fixtureRoot = resolve("fixtures/sample-app");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export interface RunningFixtureServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<RunningFixtureServer> {
  const server = createServer(async (req, res) => {
    const requestPath = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
    const filePath = resolve(fixtureRoot, `.${requestPath}`);

    if (!filePath.startsWith(fixtureRoot)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    try {
      const content = await readFile(filePath);
      const extension = extname(filePath).toLowerCase();
      res.statusCode = 200;
      res.setHeader("content-type", mimeTypes[extension] ?? "application/octet-stream");
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("Not found");
    }
  });

  const port = await listenOnRandomPort(server);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await closeServer(server);
    }
  };
}

function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start fixture server"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}
