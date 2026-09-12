import path from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asStructuredError, TunnelGPTError } from "../core/errors.js";
import { runBounded, runConfirmed, type ManuMcpServices } from "./services.js";
import type { ManuMcpConfig } from "./config.js";

const MAX_PATH_CHARS = 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PATCH_CHARS = 1024 * 1024;
const DESKTOP_COMPATIBILITY_ALIASES = new Set(["desktop", "escritorio", "workspace"]);
const DOWNLOADS_ALIASES = new Set(["downloads", "descargas"]);
const PC_ALIASES = new Set(["pc", "computer", "ordenador", "computer-profile"]);
const USER_PROFILE_DIRECTORY_NAMES = new Set([
    "appdata",
    "documents",
    "documentos",
    "downloads",
    "descargas",
    "music",
    "música",
    "pictures",
    "imágenes",
    "videos",
    "desktop",
    "escritorio",
    "onedrive",
]);
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const pathSchema = z.string()
    .max(MAX_PATH_CHARS)
    .refine((value) => !/[\0\r\n]/u.test(value), "La ruta no puede contener NUL ni saltos de línea.");
const requiredPathSchema = z.string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .refine((value) => !/[\0\r\n]/u.test(value), "La ruta no puede contener NUL ni saltos de línea.");
const rootSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u)
    .describe("Destino: workspace/desktop para Escritorio, downloads para Descargas o pc para cualquier carpeta del perfil de usuario de Windows.")
    .optional();
const confirmationSchema = z.string().max(8192).optional();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/iu);

function result(value: unknown): { content: [{ type: "text"; text: string }] } {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
    return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(asStructuredError(error), null, 2) }],
    };
}

async function guarded<T>(services: ManuMcpServices, extra: Extra, operation: () => Promise<T>): Promise<
    { content: [{ type: "text"; text: string }] } | { isError: true; content: [{ type: "text"; text: string }] }
> {
    try {
        return result(await runBounded(services, extra.signal, operation));
    }
    catch (error) {
        return failure(error);
    }
}

function normalizeRoot(root: string | undefined, config: ManuMcpConfig): string | undefined {
    const normalized = root?.toLowerCase();
    if (normalized === undefined)
        return undefined;
    if (DESKTOP_COMPATIBILITY_ALIASES.has(normalized))
        return config.workspaceAlias;
    if (DOWNLOADS_ALIASES.has(normalized))
        return config.downloadsAlias;
    if (PC_ALIASES.has(normalized))
        return config.pcAlias;
    return root;
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toPortableRelative(value: string): string {
    return value.replace(/[\\/]+/gu, "/");
}

function isWindowsAbsolute(rawPath: string): boolean {
    return process.platform === "win32" && (/^[A-Za-z]:[\\/]/u.test(rawPath) || /^\\\\/u.test(rawPath));
}

function isAbsoluteRequest(rawPath: string): boolean {
    return path.isAbsolute(rawPath) || isWindowsAbsolute(rawPath);
}

function hasParentTraversal(rawPath: string): boolean {
    return rawPath.replace(/[\\/]+/gu, path.sep).split(path.sep).some((segment) => segment === "..");
}

function absoluteTarget(rawPath: string, requestedRoot: string | undefined, config: ManuMcpConfig): { path: string; rootAlias: string } {
    if (isWindowsAbsolute(rawPath) && process.platform !== "win32")
        return { path: rawPath, rootAlias: requestedRoot ?? config.pcAlias };
    const absolute = path.resolve(rawPath);
    const candidates = [
        { alias: config.workspaceAlias, path: config.workspacePath },
        { alias: config.downloadsAlias, path: config.downloadsPath },
        { alias: config.pcAlias, path: config.pcPath },
    ]
        .filter((candidate) => requestedRoot === undefined || candidate.alias === requestedRoot)
        .filter((candidate) => isWithin(candidate.path, absolute))
        .sort((left, right) => right.path.length - left.path.length);
    const selected = candidates[0];
    if (selected === undefined) {
        // Keep the absolute value so PathAuthorizer returns its normal
        // outside-root/UNC/device error instead of silently remapping it.
        return { path: rawPath, rootAlias: requestedRoot ?? config.pcAlias };
    }
    const relative = toPortableRelative(path.relative(selected.path, absolute));
    return {
        path: relative.length === 0 ? `${selected.alias}:/` : `${selected.alias}:/${relative}`,
        rootAlias: selected.alias,
    };
}

function embeddedTarget(rawPath: string, config: ManuMcpConfig): { alias: string; relative: string } | undefined {
    if (isWindowsAbsolute(rawPath))
        return undefined;
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,31}):[\\/](.*)$/u.exec(rawPath);
    if (match === null)
        return undefined;
    const alias = normalizeRoot(match[1], config);
    if (alias === undefined)
        return undefined;
    return { alias, relative: match[2] ?? "" };
}

function normalizedTarget(rawPath: string, rawRoot: string | undefined, config: ManuMcpConfig): { path: string; rootAlias: string | undefined } {
    const requestedRoot = normalizeRoot(rawRoot, config);
    if (isAbsoluteRequest(rawPath)) {
        if (hasParentTraversal(rawPath))
            return { path: rawPath, rootAlias: requestedRoot ?? config.pcAlias };
        return absoluteTarget(rawPath, requestedRoot, config);
    }

    const embedded = embeddedTarget(rawPath, config);
    if (embedded !== undefined) {
        return {
            path: `${embedded.alias}:/${embedded.relative}`,
            // Preserve a conflicting explicit root so PathAuthorizer rejects
            // mismatched aliases rather than silently changing the request.
            rootAlias: requestedRoot === undefined || requestedRoot === embedded.alias ? embedded.alias : requestedRoot,
        };
    }

    if (rawPath.length === 0)
        return { path: `${requestedRoot ?? config.workspaceAlias}:/`, rootAlias: requestedRoot ?? config.workspaceAlias };

    if (requestedRoot === undefined) {
        const firstSegment = rawPath.split(/[\\/]/u)[0]?.toLowerCase() ?? "";
        if (DOWNLOADS_ALIASES.has(firstSegment))
            return { path: `${config.downloadsAlias}:/${rawPath.slice(firstSegment.length).replace(/^[\\/]+/u, "")}`, rootAlias: config.downloadsAlias };
        if (DESKTOP_COMPATIBILITY_ALIASES.has(firstSegment))
            return { path: `${config.workspaceAlias}:/${rawPath.slice(firstSegment.length).replace(/^[\\/]+/u, "")}`, rootAlias: config.workspaceAlias };
        if (USER_PROFILE_DIRECTORY_NAMES.has(firstSegment))
            return { path: `${config.pcAlias}:/${toPortableRelative(rawPath)}`, rootAlias: config.pcAlias };
    }

    return { path: rawPath, rootAlias: requestedRoot ?? config.workspaceAlias };
}

function relativeMarker(rawPath: string, alias: string): string {
    const prefix = `${alias}:/`;
    if (rawPath.startsWith(prefix))
        return rawPath.slice(prefix.length);
    return rawPath;
}

function writeCall<T>(services: ManuMcpServices, extra: Extra, token: string | undefined, confirmed: boolean, operation: () => Promise<T>) {
    if ((token === undefined && confirmed) || (token !== undefined && !confirmed)) {
        return guarded(services, extra, async () => {
            throw new TunnelGPTError("CONFIRMATION_INVALID", "Usa confirmed=true junto con el confirmationToken, o no envíes ninguno para solicitar una vista previa.");
        });
    }
    return guarded(services, extra, () => runConfirmed(services, token, operation));
}

export function registerManuMcpTools(server: McpServer, services: ManuMcpServices): void {
    server.registerTool("get_device_health", {
        title: "ManuMCP health",
        description: "Comprueba si ManuMCP está activo y muestra los destinos de archivos autorizados: Escritorio, Descargas y el perfil de usuario de Windows.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, _extra) => result({
        ok: true,
        name: services.config.name,
        version: services.config.version,
        platform: process.platform,
        node: process.version,
        profile: services.config.profile,
        workspace: `${services.config.workspaceAlias}:/`,
        authorizedRoots: [
            `${services.config.workspaceAlias}:/ (Escritorio)`,
            `${services.config.downloadsAlias}:/ (Descargas)`,
            `${services.config.pcAlias}:/ (perfil de usuario de Windows)`,
        ],
        transport: services.config.mode,
        pid: process.pid,
    }));

    server.registerTool("list_workspace", {
        title: "List workspace files",
        description: "Lista archivos y carpetas. Usa workspace:/ o desktop:/ para el Escritorio, downloads:/ para Descargas y pc:/ para cualquier carpeta dentro del perfil de usuario de Windows. No accede a las carpetas de otros usuarios ni a rutas fuera de los destinos autorizados.",
        inputSchema: {
            path: pathSchema.default(""),
            root: rootSchema,
            maxDepth: z.number().int().min(1).max(5).default(3),
            maxEntries: z.number().int().min(1).max(500).default(100),
            includeHidden: z.boolean().default(false),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guarded(services, extra, async () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        const start = await services.authorizer.authorizeExisting(target.path, {
            rootAlias: target.rootAlias,
            kind: "directory",
        });
        const walked = await services.walker.collect(start, {
            maxDepth: args.maxDepth,
            includeHidden: args.includeHidden,
            scanBudget: Math.min(50_000, Math.max(1_000, args.maxEntries * 100)),
            signal: extra.signal,
        });
        return {
            ok: true,
            root: start.displayPath,
            entries: walked.entries.slice(0, args.maxEntries).map((entry) => ({
                path: entry.displayPath,
                name: entry.name,
                type: entry.type,
                size: entry.size,
                modifiedAt: new Date(entry.mtimeMs).toISOString(),
                depth: entry.depth,
            })),
            returned: Math.min(walked.entries.length, args.maxEntries),
            truncated: walked.entries.length > args.maxEntries || walked.scanLimitReached,
            scanLimitReached: walked.scanLimitReached,
        };
    }));

    server.registerTool("read_workspace_file", {
        title: "Read workspace file",
        description: "Lee texto UTF-8 de un archivo autorizado. Usa workspace:/ o desktop:/ para Escritorio, downloads:/ para Descargas y pc:/ para cualquier carpeta del perfil de usuario de Windows. Las credenciales potenciales y los binarios se bloquean.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            startLine: z.number().int().min(1).default(1),
            endLine: z.number().int().min(1).optional(),
            maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(64 * 1024),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guarded(services, extra, async () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        const file = await services.authorizer.authorizeExisting(target.path, {
            rootAlias: target.rootAlias,
            kind: "file",
            maxBytes: args.maxBytes,
        });
        return { ok: true, ...(await services.reader.readText(file, {
            startLine: args.startLine,
            ...(args.endLine === undefined ? {} : { endLine: args.endLine }),
            maxBytes: args.maxBytes,
            signal: extra.signal,
        })) };
    }));

    server.registerTool("search_workspace", {
        title: "Search workspace",
        description: "Busca texto dentro de un destino autorizado. Usa workspace:/ o desktop:/ para Escritorio, downloads:/ para Descargas y pc:/ para cualquier carpeta del perfil de usuario de Windows; devuelve coincidencias acotadas y omite secretos o archivos demasiado grandes.",
        inputSchema: {
            query: z.string().min(1).max(4096),
            path: pathSchema.default(""),
            root: rootSchema,
            glob: z.string().max(MAX_PATH_CHARS).optional(),
            caseSensitive: z.boolean().default(false),
            maxMatches: z.number().int().min(1).max(200).default(50),
            contextLines: z.number().int().min(0).max(5).default(1),
            maxFileBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(MAX_READ_BYTES),
            maxOutputBytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES).default(MAX_OUTPUT_BYTES),
            afterPath: pathSchema.optional(),
            afterLine: z.number().int().min(1).optional(),
            afterColumn: z.number().int().min(1).optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guarded(services, extra, async () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        const start = await services.authorizer.authorizeExisting(target.path, {
            rootAlias: target.rootAlias,
            kind: "directory",
        });
        const afterTarget = args.afterPath === undefined ? undefined : normalizedTarget(args.afterPath, start.root.alias, services.config);
        const after = afterTarget === undefined ? undefined : {
            path: relativeMarker(afterTarget.path, start.root.alias),
            line: args.afterLine ?? 1,
            column: args.afterColumn ?? 1,
        };
        return {
            ok: true,
            root: start.displayPath,
            ...(await services.search.searchText(start, args.query, {
                ...(args.glob === undefined ? {} : { glob: args.glob }),
                caseSensitive: args.caseSensitive,
                maxMatches: args.maxMatches,
                contextLines: args.contextLines,
                maxFileBytes: args.maxFileBytes,
                maxOutputBytes: args.maxOutputBytes,
                ...(after === undefined ? {} : { after }),
                signal: extra.signal,
            })),
        };
    }));

    server.registerTool("create_workspace_directory", {
        title: "Create workspace directory",
        description: "Prepara la creación de una carpeta en Escritorio, Descargas o cualquier carpeta del perfil de usuario usando workspace:/, downloads:/ o pc:/. La primera llamada solo muestra una vista previa y token. La segunda exige confirmed=true y ese token.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (args, extra) => writeCall(services, extra, args.confirmationToken, args.confirmed, () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        return services.writer.createDirectory({
            path: target.path,
            ...(target.rootAlias === undefined ? {} : { root: target.rootAlias }),
            ...(args.confirmationToken === undefined ? {} : { confirmationToken: args.confirmationToken }),
            confirmed: args.confirmed,
        });
    }));

    server.registerTool("create_workspace_file", {
        title: "Create workspace text file",
        description: "Prepara un archivo de texto UTF-8 en Escritorio, Descargas o cualquier carpeta del perfil de usuario usando workspace:/, downloads:/ o pc:/; nunca ejecuta el contenido y exige confirmación explícita antes de escribir.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            content: z.string().max(MAX_WRITE_BYTES),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (args, extra) => writeCall(services, extra, args.confirmationToken, args.confirmed, () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        return services.writer.createTextFile({
            path: target.path,
            content: args.content,
            ...(target.rootAlias === undefined ? {} : { root: target.rootAlias }),
            ...(args.confirmationToken === undefined ? {} : { confirmationToken: args.confirmationToken }),
            confirmed: args.confirmed,
        });
    }));

    server.registerTool("replace_workspace_text", {
        title: "Replace workspace text range",
        description: "Prepara un reemplazo de líneas en un archivo autorizado mediante hash de precondición; no sobrescribe cambios concurrentes y exige confirmación.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            startLine: z.number().int().min(1),
            endLine: z.number().int().min(1),
            replacement: z.string().max(MAX_WRITE_BYTES),
            expectedHash: hashSchema,
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (args, extra) => writeCall(services, extra, args.confirmationToken, args.confirmed, () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        return services.writer.replaceTextRange({
            path: target.path,
            startLine: args.startLine,
            endLine: args.endLine,
            replacement: args.replacement,
            expectedHash: args.expectedHash,
            ...(target.rootAlias === undefined ? {} : { root: target.rootAlias }),
            ...(args.confirmationToken === undefined ? {} : { confirmationToken: args.confirmationToken }),
            confirmed: args.confirmed,
        }, extra.signal);
    }));

    server.registerTool("apply_workspace_patch", {
        title: "Apply workspace patch",
        description: "Prepara la aplicación de un parche unificado en Escritorio, Descargas o cualquier carpeta del perfil de usuario usando workspace:/, downloads:/ o pc:/. Usa hash de precondición y exige confirmación.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            patch: z.string().min(1).max(MAX_PATCH_CHARS),
            expectedHash: hashSchema,
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (args, extra) => writeCall(services, extra, args.confirmationToken, args.confirmed, () => {
        const target = normalizedTarget(args.path, args.root, services.config);
        return services.writer.applyPatch({
            path: target.path,
            patch: args.patch,
            expectedHash: args.expectedHash,
            ...(target.rootAlias === undefined ? {} : { root: target.rootAlias }),
            ...(args.confirmationToken === undefined ? {} : { confirmationToken: args.confirmationToken }),
            confirmed: args.confirmed,
        }, extra.signal);
    }));
}
