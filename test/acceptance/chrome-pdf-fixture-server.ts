import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_REQUEST_BYTES = 8 * 1024;
const TRANSFER_LIMIT_BYTES = 256 * 1024 * 1024;
const SESSION_COOKIE = "placekeeper_fixture_session=authenticated";

export interface ChromePdfFixtureSnapshot {
  readonly authenticatedSessions: number;
  readonly suffixless: number;
  readonly redirects: number;
  readonly singleUseAccepted: number;
  readonly singleUseRejected: number;
  readonly slow: number;
  readonly invalid: number;
  readonly interrupted: number;
  readonly overBudget: number;
}

export interface ChromePdfFixtureServer {
  readonly origin: string;
  snapshot(): ChromePdfFixtureSnapshot;
  close(): Promise<void>;
}

interface FixtureOptions {
  readonly pdfBytes: Uint8Array;
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.cookie?.split(";").some((value) => value.trim() === SESSION_COOKIE) === true;
}

function requireAuthentication(request: IncomingMessage, response: ServerResponse): boolean {
  if (authenticated(request)) return true;
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end("Authentication required");
  return false;
}

function pdfHeaders(length: number): Record<string, string> {
  return {
    "Cache-Control": "no-store, private",
    "Content-Disposition": "inline",
    "Content-Length": String(length),
    "Content-Type": "application/pdf",
    "X-Content-Type-Options": "nosniff",
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > MAX_REQUEST_BYTES) throw new Error("fixture-request-too-large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function landing(response: ServerResponse): void {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Placekeeper Chrome fixture</title></head>
  <body>
    <main>
      <h1>Placekeeper Chrome fixture</h1>
      <form action="/session" method="post">
        <label>Fixture password <input name="password" type="password" autocomplete="off"></label>
        <button type="submit">Start authenticated session</button>
      </form>
      <a href="/document?id=42">Suffixless PDF</a>
      <form action="/redirected-document" method="post">
        <input name="intent" type="hidden" value="open">
        <button type="submit">Authenticated single-use PDF</button>
      </form>
    </main>
  </body>
</html>`);
}

export async function startChromePdfFixtureServer(
  options: FixtureOptions,
): Promise<ChromePdfFixtureServer> {
  if (options.pdfBytes.byteLength === 0) throw new Error("fixture PDF must not be empty");
  const state = {
    authenticatedSessions: 0,
    suffixless: 0,
    redirects: 0,
    singleUseAccepted: 0,
    singleUseRejected: 0,
    slow: 0,
    invalid: 0,
    interrupted: 0,
    overBudget: 0,
  };
  let singleUseConsumed = false;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        landing(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/worker-probe") {
        response.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const body = new URLSearchParams((await readBody(request)).toString("utf8"));
        if (body.get("password") !== "reader") {
          response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("Denied");
          return;
        }
        state.authenticatedSessions += 1;
        response.writeHead(303, {
          "Cache-Control": "no-store",
          Location: "/",
          "Set-Cookie": `${SESSION_COOKIE}; HttpOnly; SameSite=Strict; Path=/`,
        });
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/document") {
        if (!requireAuthentication(request, response)) return;
        state.suffixless += 1;
        response.writeHead(200, pdfHeaders(options.pdfBytes.byteLength));
        response.end(options.pdfBytes);
        return;
      }
      if (request.method === "POST" && url.pathname === "/redirected-document") {
        if (!requireAuthentication(request, response)) return;
        await readBody(request);
        state.redirects += 1;
        response.writeHead(307, {
          "Cache-Control": "no-store",
          Location: "/single-use-document",
        });
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/single-use-document") {
        if (!requireAuthentication(request, response)) return;
        await readBody(request);
        if (singleUseConsumed) {
          state.singleUseRejected += 1;
          response.writeHead(410, {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
          });
          response.end("Response already consumed");
          return;
        }
        singleUseConsumed = true;
        state.singleUseAccepted += 1;
        response.writeHead(200, pdfHeaders(options.pdfBytes.byteLength));
        response.end(options.pdfBytes);
        return;
      }
      if (request.method === "GET" && url.pathname === "/slow-document") {
        if (!requireAuthentication(request, response)) return;
        state.slow += 1;
        response.writeHead(200, pdfHeaders(options.pdfBytes.byteLength));
        const midpoint = Math.ceil(options.pdfBytes.byteLength / 2);
        response.write(options.pdfBytes.subarray(0, midpoint));
        setTimeout(() => response.end(options.pdfBytes.subarray(midpoint)), 25);
        return;
      }
      if (request.method === "GET" && url.pathname === "/invalid-document") {
        if (!requireAuthentication(request, response)) return;
        state.invalid += 1;
        const bytes = Buffer.from("This response claims to be a PDF but is not one.\n");
        response.writeHead(200, pdfHeaders(bytes.byteLength));
        response.end(bytes);
        return;
      }
      if (request.method === "GET" && url.pathname === "/interrupted-document") {
        if (!requireAuthentication(request, response)) return;
        state.interrupted += 1;
        response.writeHead(200, pdfHeaders(options.pdfBytes.byteLength));
        response.write(options.pdfBytes.subarray(0, Math.min(32, options.pdfBytes.byteLength)));
        setImmediate(() => response.destroy());
        return;
      }
      if ((request.method === "HEAD" || request.method === "GET") &&
        url.pathname === "/over-budget-document") {
        if (!requireAuthentication(request, response)) return;
        state.overBudget += 1;
        response.writeHead(200, pdfHeaders(TRANSFER_LIMIT_BYTES + 1));
        response.end();
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    } catch {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Chrome PDF fixture server did not bind a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    snapshot: () => ({ ...state }),
    close: () => new Promise<void>((resolveClose, reject) => {
      server.closeAllConnections();
      server.close((error) => error === undefined ? resolveClose() : reject(error));
    }),
  };
}
