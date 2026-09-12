import crypto from "node:crypto";
import http from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { asStructuredError } from "../core/errors.js";
import { loadConfig } from "./config.js";
import { registerManuMcpTools } from "./mcp-tools.js";
import { createServices } from "./services.js";
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const startedAt = new Date().toISOString();
function createMcpServer(services) {
    const server = new McpServer({ name: services.config.name, version: services.config.version });
    registerManuMcpTools(server, services);
    return server;
}
function setCorsHeaders(response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version, Last-Event-ID");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}
function sendJson(response, status, body) {
    if (response.headersSent)
        return;
    const payload = JSON.stringify(body);
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(payload, "utf8"));
    response.end(payload);
}
function sendText(response, status, body) {
    if (response.headersSent)
        return;
    response.statusCode = status;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
    response.end(body);
}
async function readJsonBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > MAX_HTTP_BODY_BYTES)
            throw new Error("La petición MCP supera el límite de 2 MiB.");
        chunks.push(buffer);
    }
    if (chunks.length === 0)
        throw new Error("La petición MCP no contiene JSON.");
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new Error("La petición MCP contiene JSON inválido.");
    }
}
function hasValidBearer(request, expectedToken) {
    const value = request.headers.authorization;
    if (value === undefined || !value.startsWith("Bearer "))
        return false;
    const supplied = Buffer.from(value.slice("Bearer ".length), "utf8");
    const expected = Buffer.from(expectedToken, "utf8");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function healthPayload(config) {
    return {
        ok: true,
        name: config.name,
        version: config.version,
        status: "ready",
        mode: config.mode,
        profile: config.profile,
        workspace: `${config.workspaceAlias}:/`,
        platform: process.platform,
        node: process.version,
        pid: process.pid,
        startedAt,
        note: "Solo se expone el workspace autorizado; no hay shell ni control de teclado, ratón o escritorio.",
    };
}
async function handleMcpRequest(request, response, services) {
    const token = services.config.localToken;
    if (token === undefined || !hasValidBearer(request, token)) {
        response.setHeader("WWW-Authenticate", 'Bearer realm="ManuMCP"');
        sendJson(response, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Bearer token requerido." } });
        return;
    }
    if (request.method !== "POST") {
        sendJson(response, 405, { ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "Usa POST para el endpoint MCP." } });
        return;
    }
    let body;
    try {
        body = await readJsonBody(request);
    }
    catch (error) {
        sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : "JSON inválido." } });
        return;
    }
    const mcpServer = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({
        // The server is deliberately stateless: the secure tunnel can reconnect
        // and every request still uses the same bounded local services.
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
    });
    response.once("close", () => {
        void transport.close();
        void mcpServer.close();
    });
    try {
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
    }
    catch (error) {
        if (!response.headersSent) {
            const structured = asStructuredError(error);
            sendJson(response, 500, {
                jsonrpc: "2.0",
                error: { code: -32603, message: structured.error.message },
                id: null,
            });
        }
    }
}
async function startHttp(config, services) {
    const server = http.createServer((request, response) => {
        setCorsHeaders(response);
        if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
        }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/healthz" && request.method === "GET") {
            sendJson(response, 200, healthPayload(config));
            return;
        }
        if (url.pathname === "/" && request.method === "GET") {
            sendText(response, 200, "ManuMCP está activo. Endpoint MCP: POST /mcp\n");
            return;
        }
        if (url.pathname === "/mcp") {
            void handleMcpRequest(request, response, services);
            return;
        }
        sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Ruta no encontrada." } });
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = () => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(config.port, "127.0.0.1");
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    console.log(`ManuMCP listo en http://127.0.0.1:${port}/mcp`);
    console.log(`Workspace autorizado: ${config.workspaceAlias}:/ | perfil: ${config.profile}`);
    const shutdown = () => {
        services.admission.close();
        server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
async function startStdio(config, services) {
    const mcpServer = createMcpServer(services);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error(`ManuMCP stdio listo | ${config.workspaceAlias}:/ | perfil: ${config.profile}`);
    const shutdown = () => {
        services.admission.close();
        void mcpServer.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
async function main() {
    const mode = process.argv.includes("--stdio") ? "stdio" : "http";
    const config = await loadConfig(mode);
    const services = await createServices(config);
    if (mode === "stdio")
        await startStdio(config, services);
    else
        await startHttp(config, services);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : "Error desconocido de ManuMCP.";
    console.error(`ManuMCP no pudo iniciar: ${message}`);
    process.exitCode = 1;
});
