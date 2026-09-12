import { z } from "zod";
import { asStructuredError, TunnelGPTError } from "../core/errors.js";
import { runBounded, runConfirmed } from "./services.js";
const MAX_PATH_CHARS = 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PATCH_CHARS = 1024 * 1024;
const DESKTOP_COMPATIBILITY_ALIAS = "desktop";
const pathSchema = z.string()
    .max(MAX_PATH_CHARS)
    .refine((value) => !/[\0\r\n]/u.test(value), "La ruta no puede contener NUL ni saltos de línea.");
const requiredPathSchema = z.string()
    .min(1)
    .max(MAX_PATH_CHARS)
    .refine((value) => !/[\0\r\n]/u.test(value), "La ruta no puede contener NUL ni saltos de línea.");
const rootSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u)
    .describe("Alias del directorio autorizado: workspace (canónico) o desktop (alias compatible del mismo directorio).")
    .optional();
const confirmationSchema = z.string().max(8192).optional();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/iu);
function result(value) {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function failure(error) {
    return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(asStructuredError(error), null, 2) }],
    };
}
async function guarded(services, extra, operation) {
    try {
        return result(await runBounded(services, extra.signal, operation));
    }
    catch (error) {
        return failure(error);
    }
}
function normalizeRoot(root, alias) {
    if (root?.toLowerCase() === DESKTOP_COMPATIBILITY_ALIAS && alias === "workspace")
        return alias;
    return root;
}
function workspacePath(rawPath, root, alias) {
    const desktopPrefix = `${DESKTOP_COMPATIBILITY_ALIAS}:/`;
    if (rawPath.toLowerCase().startsWith(desktopPrefix))
        return `${alias}:/${rawPath.slice(desktopPrefix.length)}`;
    if (rawPath.length > 0)
        return rawPath;
    return `${root ?? alias}:/`;
}
function normalizedTarget(rawPath, rawRoot, alias) {
    const rootAlias = normalizeRoot(rawRoot, alias);
    return { path: workspacePath(rawPath, rootAlias, alias), rootAlias };
}
function relativeMarker(rawPath, alias) {
    const prefix = `${alias}:/`;
    if (rawPath.startsWith(prefix))
        return rawPath.slice(prefix.length);
    return rawPath;
}
function writeCall(services, extra, token, confirmed, operation) {
    if ((token === undefined && confirmed) || (token !== undefined && !confirmed)) {
        return guarded(services, extra, async () => {
            throw new TunnelGPTError("CONFIRMATION_INVALID", "Usa confirmed=true junto con el confirmationToken, o no envíes ninguno para solicitar una vista previa.");
        });
    }
    return guarded(services, extra, () => runConfirmed(services, token, operation));
}
export function registerManuMcpTools(server, services) {
    server.registerTool("get_device_health", {
        title: "ManuMCP health",
        description: "Comprueba si el agente local ManuMCP está activo y qué directorio único tiene autorizado. En Windows, la instalación predeterminada apunta al Escritorio real.",
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
        transport: services.config.mode,
        pid: process.pid,
    }));
    server.registerTool("list_workspace", {
        title: "List workspace files",
        description: "Lista archivos y carpetas dentro de workspace:/; en la instalación predeterminada de Windows ese alias es el Escritorio real. También acepta desktop:/ como alias compatible del mismo directorio. Usa profundidad y presupuesto acotados y no accede al resto del ordenador.",
        inputSchema: {
            path: pathSchema.default(""),
            root: rootSchema,
            maxDepth: z.number().int().min(1).max(5).default(3),
            maxEntries: z.number().int().min(1).max(500).default(100),
            includeHidden: z.boolean().default(false),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guarded(services, extra, async () => {
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
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
        description: "Lee texto UTF-8 de un archivo autorizado de workspace:/ (el Escritorio real por defecto en Windows), con líneas numeradas, hash y límite de bytes. Los secretos potenciales y binarios se bloquean.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            startLine: z.number().int().min(1).default(1),
            endLine: z.number().int().min(1).optional(),
            maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).default(64 * 1024),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guarded(services, extra, async () => {
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
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
        description: "Busca texto dentro del directorio autorizado de workspace:/ (el Escritorio real por defecto en Windows); también acepta desktop:/ como alias compatible. Devuelve coincidencias acotadas y omite archivos secretos o demasiado grandes.",
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
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
        const start = await services.authorizer.authorizeExisting(target.path, {
            rootAlias: target.rootAlias,
            kind: "directory",
        });
        const afterTarget = args.afterPath === undefined ? undefined : normalizedTarget(args.afterPath, undefined, start.root.alias);
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
        description: "Prepara la creación de una carpeta dentro de workspace:/ (el Escritorio real por defecto en Windows); también acepta desktop:/ como alias compatible. La primera llamada solo muestra una vista previa y token. La segunda exige confirmed=true y ese token.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (args, extra) => writeCall(services, extra, args.confirmationToken, args.confirmed, () => {
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
        return services.writer.createDirectory({
            path: target.path,
            ...(target.rootAlias === undefined ? {} : { root: target.rootAlias }),
            ...(args.confirmationToken === undefined ? {} : { confirmationToken: args.confirmationToken }),
            confirmed: args.confirmed,
        });
    }));
    server.registerTool("create_workspace_file", {
        title: "Create workspace text file",
        description: "Prepara un archivo de texto UTF-8 dentro de workspace:/ (el Escritorio real por defecto en Windows); también acepta desktop:/ como alias compatible y nunca ejecuta el contenido. La primera llamada es vista previa y la segunda requiere confirmación explícita.",
        inputSchema: {
            path: requiredPathSchema,
            root: rootSchema,
            content: z.string().max(MAX_WRITE_BYTES),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    }, async (args, extra) => writeCall(services, extra, args.confirmationToken, args.confirmed, () => {
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
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
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
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
        description: "Prepara la aplicación de un parche unificado a un archivo dentro de workspace:/ (el Escritorio real por defecto en Windows); también acepta desktop:/ como alias compatible. Usa hash de precondición y exige confirmación.",
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
        const target = normalizedTarget(args.path, args.root, services.config.workspaceAlias);
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
