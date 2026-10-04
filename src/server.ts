import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TrustError } from "./errors.js";
import { constantTimeEqual as timingSafeTokenEqual } from "./hashing.js";
import type { TrustRegistry } from "./registry.js";

interface JsonBody {
  [key: string]: unknown;
}

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof TrustError) {
    sendJson(res, error.httpStatus, { error: error.message, code: error.code });
    return;
  }
  sendJson(res, 500, { error: error instanceof Error ? error.message : "internal error" });
}

async function readJson(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new TrustError("VALIDATION", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TrustError("VALIDATION", "request body must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TrustError("VALIDATION", "request body must be a JSON object");
  }
  return parsed as JsonBody;
}

export interface ServerHandle {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * HTTP surface over a TrustRegistry. Reads are open; writes (registering
 * agents, recording outcomes, changing thresholds or calibration) require
 * `Authorization: Bearer <token>` when the server was given a token. When no
 * token is configured all writes are rejected with 401 — an unauthenticated
 * write path is never shipped accidentally.
 */
export function createTrustServer(
  registry: TrustRegistry,
  options: { token?: string | undefined; clock?: () => number } = {},
): Server {
  const token = options.token;
  const clock = options.clock ?? Date.now;

  const requireWriteAuth = (req: IncomingMessage): void => {
    if (token === undefined) {
      throw new TrustError("UNAUTHORIZED", "server has no write token configured; set one to enable writes");
    }
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !timingSafeTokenEqual(header.slice("Bearer ".length), token)) {
      throw new TrustError("UNAUTHORIZED", "missing or invalid bearer token");
    }
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter((p) => p.length > 0);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok", agents: registry.listAgents().length, at: clock() });
      return;
    }

    if (method === "GET" && url.pathname === "/audit") {
      const log = registry.auditLog;
      if (log === undefined) {
        sendJson(res, 404, { error: "no audit ledger configured on this server" });
        return;
      }
      sendJson(res, 200, { ...log.report(), tail: log.tail(20) });
      return;
    }

    if (parts[0] === "agents") {
      const id = parts[1];
      if (id === undefined) {
        if (method === "GET") {
          sendJson(res, 200, { agents: registry.listAgents() });
          return;
        }
        if (method === "POST") {
          requireWriteAuth(req);
          const body = await readJson(req);
          const profile = registry.registerAgent(String(body["id"] ?? ""));
          sendJson(res, 201, { registered: profile.id, at: profile.registeredAt });
          return;
        }
      } else if (parts.length === 2) {
        if (method === "GET") {
          sendJson(res, 200, {
            id,
            score: registry.score(id),
            drift: registry.drift(id),
            decision: registry.decide(id),
          });
          return;
        }
      } else if (parts.length === 3 && parts[2] === "drift" && method === "GET") {
        sendJson(res, 200, registry.drift(id));
        return;
      }
    }

    if (method === "POST" && url.pathname === "/outcomes") {
      requireWriteAuth(req);
      const body = await readJson(req);
      const record = registry.recordOutcome(String(body["agentId"] ?? ""), {
        taskId: String(body["taskId"] ?? ""),
        kind: body["kind"] as never,
        quality: body["quality"] === null || body["quality"] === undefined ? undefined : Number(body["quality"]),
        at: body["at"] === null || body["at"] === undefined ? undefined : Number(body["at"]),
      });
      const decision = registry.decide(String(body["agentId"] ?? ""));
      sendJson(res, 201, { recorded: record, decision });
      return;
    }

    if (method === "POST" && url.pathname === "/policy") {
      requireWriteAuth(req);
      const body = await readJson(req);
      const thresholds = registry.updateThresholds(body as Record<string, number>);
      sendJson(res, 200, { thresholds });
      return;
    }

    if (method === "POST" && url.pathname === "/calibration") {
      requireWriteAuth(req);
      const body = await readJson(req);
      const calibration = registry.recalibrate(body as Record<string, number>);
      sendJson(res, 200, { calibration });
      return;
    }

    sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
  };

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendError(res, error);
      else res.destroy();
    });
  });
}

export function listenTrustServer(
  registry: TrustRegistry,
  port: number,
  options: { token?: string | undefined } = {},
): Promise<ServerHandle> {
  const server = createTrustServer(registry, options);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        server,
        port: bound,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
