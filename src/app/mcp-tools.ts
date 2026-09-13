import path from "node:path";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asStructuredError, TunnelGPTError } from "../core/errors.js";
import { runBounded, runConfirmed, type ManuMcpServices } from "./services.js";
import { keyCodeFromName, type CommandShell } from "./system-control.js";
import type { ManuMcpConfig } from "./config.js";

const MAX_PATH_CHARS = 1024;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PATCH_CHARS = 1024 * 1024;
const MAX_COMMAND_CHARS = 16 * 1024;
const MAX_ARGUMENT_CHARS = 2048;
const MAX_TYPED_TEXT_CHARS = 4096;
const MAX_CONFIRMATION_SUMMARY_CHARS = 4096;
const DEFAULT_COMMAND_SHELL: CommandShell = process.platform === "win32" ? "powershell" : "sh";
const browserUrlSchema = z.string()
    .min(1)
    .max(8192)
    .url("La URL no es válida.")
    .refine((value) => value === value.trim() && !/\s/u.test(value), "La URL no puede contener espacios ni saltos de línea.")
    .refine((value) => {
        const parsed = new URL(value);
        const authorityStart = value.indexOf("://") + 3;
        const authority = value.slice(authorityStart).split(/[/?#]/u, 1)[0] ?? "";
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && authority.includes("@") === false && parsed.username.length === 0 && parsed.password.length === 0;
    }, "Solo se permiten URLs HTTP/HTTPS sin información de usuario ni contraseña.");
const DESKTOP_COMPATIBILITY_ALIASES = new Set(["desktop", "escritorio", "workspace"]);
const DOWNLOADS_ALIASES = new Set(["downloads", "descargas"]);
const PC_ALIASES = new Set(["pc", "computer", "ordenador", "computer-profile"]);
const USER_PROFILE_DIRECTORY_NAMES = new Set([
    "appdata",
    "applications",
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
    "users",
    "volumes",
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
    .describe("Destino: workspace/desktop para Escritorio, downloads para Descargas, pc para cualquier carpeta del equipo y pc-<letra> para otras unidades Windows descubiertas.")
    .optional();
const confirmationSchema = z.string().max(8192).optional();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/iu);

type ToolContent =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" };
type ToolResult = { content: ToolContent[] } | { isError: true; content: [{ type: "text"; text: string }] };

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
    ToolResult
> {
    try {
        return result(await runBounded(services, extra.signal, operation));
    }
    catch (error) {
        return failure(error);
    }
}

async function guardedContent(services: ManuMcpServices, extra: Extra, operation: () => Promise<ToolContent[]>): Promise<ToolResult> {
    try {
        return { content: await runBounded(services, extra.signal, operation) };
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
    const candidates = config.access.allowedRoots
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

function assertControlProfile(services: ManuMcpServices): void {
    if (services.config.profile !== "edit_safe")
        throw new TunnelGPTError("PROFILE_READ_ONLY", "El control del ordenador está desactivado en el perfil read_only.");
}

async function controlCwd(services: ManuMcpServices, rawPath: string | undefined): Promise<string> {
    const target = normalizedTarget(rawPath ?? `${services.config.pcAlias}:/`, undefined, services.config);
    const authorized = await services.authorizer.authorizeExisting(target.path, {
        rootAlias: target.rootAlias ?? services.config.pcAlias,
        kind: "directory",
    });
    return authorized.absolutePath;
}

async function existingControlTarget(services: ManuMcpServices, rawPath: string): Promise<string> {
    const target = normalizedTarget(rawPath, undefined, services.config);
    const authorized = await services.authorizer.authorizeExisting(target.path, {
        rootAlias: target.rootAlias ?? services.config.pcAlias,
        kind: "any",
    });
    return authorized.absolutePath;
}

function controlAction<T>(services: ManuMcpServices, extra: Extra, operation: string, digestInput: unknown, summary: string, token: string | undefined, confirmed: boolean, action: () => Promise<T>) {
    if ((token === undefined && confirmed) || (token !== undefined && !confirmed)) {
        return guarded(services, extra, async () => {
            throw new TunnelGPTError("CONFIRMATION_INVALID", "Usa confirmed=true junto con el confirmationToken, o no envíes ninguno para solicitar una vista previa.");
        });
    }
    return guarded(services, extra, async () => {
        assertControlProfile(services);
        const digest = services.confirmations.queryDigest(digestInput);
        if (token === undefined) {
            return {
                ok: true,
                applied: false,
                requiresConfirmation: true,
                confirmationToken: services.confirmations.encode(operation, digest, { summary: summary.slice(0, MAX_CONFIRMATION_SUMMARY_CHARS) }, services.config.access.limits.confirmationTtlMs),
                summary,
            };
        }
        return runConfirmed(services, token, async () => {
            services.confirmations.decode(token, operation, digest);
            return action();
        });
    });
}

function keyCodes(values: readonly string[]): number[] {
    return values.map((value) => keyCodeFromName(value));
}

function authorizedRootDescriptions(config: ManuMcpConfig): string[] {
    return config.access.allowedRoots.map((root) => {
        if (root.alias === config.workspaceAlias)
            return `${root.alias}:/ (Escritorio)`;
        if (root.alias === config.downloadsAlias)
            return `${root.alias}:/ (Descargas)`;
        if (root.alias === config.pcAlias)
            return `${root.alias}:/ (raíz completa del equipo)`;
        const drive = /^([A-Za-z]):[\\/]$/u.exec(root.path)?.[1];
        return `${root.alias}:/ (${drive === undefined ? "volumen autorizado" : `unidad ${drive.toUpperCase()}:`})`;
    });
}

export function registerManuMcpTools(server: McpServer, services: ManuMcpServices): void {
    server.registerTool("get_device_health", {
        title: "ManuMCP health",
        description: "Comprueba si ManuMCP está activo y muestra el sistema, el inventario de unidades, los volúmenes autorizados y el modo de control.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, extra) => guarded(services, extra, async () => {
        const storage = await services.system.listStorageVolumes();
        return {
            ok: true,
            name: services.config.name,
            version: services.config.version,
            platform: process.platform,
            node: process.version,
            profile: services.config.profile,
            workspace: `${services.config.workspaceAlias}:/`,
            authorizedRoots: authorizedRootDescriptions(services.config),
            volumes: storage.volumes,
            transport: services.config.mode,
            pid: process.pid,
        };
    }));

    server.registerTool("list_storage_volumes", {
        title: "List computer storage volumes",
        description: "Lista las unidades o volúmenes disponibles y el alias que ManuMCP puede usar. En Windows se descubren C:, D:, F… cuando están montadas; en macOS pc:/ cubre el sistema y /Volumes contiene discos externos.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, extra) => guarded(services, extra, () => services.system.listStorageVolumes()));

    server.registerTool("get_storage_volumes", {
        title: "Get computer storage volumes",
        description: "Alias de compatibilidad para clientes que no muestran list_storage_volumes. Lista las unidades o volúmenes disponibles y el alias que ManuMCP puede usar.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, extra) => guarded(services, extra, () => services.system.listStorageVolumes()));

    server.registerTool("list_workspace", {
        title: "List workspace files",
        description: "Lista archivos y carpetas. Usa workspace:/ o desktop:/ para el Escritorio, downloads:/ para Descargas, pc:/ para cualquier carpeta del equipo y pc-d:/, pc-f:/… para otras unidades Windows descubiertas. Las rutas sensibles y los destinos fuera de los volúmenes autorizados se bloquean.",
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
        description: "Lee texto UTF-8 de un archivo autorizado. Usa workspace:/ o desktop:/ para Escritorio, downloads:/ para Descargas, pc:/ para cualquier carpeta del equipo y el alias pc-<letra> de otra unidad Windows. Las credenciales potenciales y los binarios se bloquean.",
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
        description: "Busca texto dentro de un destino autorizado. Usa workspace:/ o desktop:/ para Escritorio, downloads:/ para Descargas, pc:/ para cualquier carpeta del equipo y pc-<letra> de otras unidades Windows; devuelve coincidencias acotadas y omite secretos o archivos demasiado grandes.",
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
        description: "Prepara la creación de una carpeta en Escritorio, Descargas o cualquier carpeta dentro de la raíz de pc:/ usando workspace:/, downloads:/ o pc:/. La primera llamada solo muestra una vista previa y token. La segunda exige confirmed=true y ese token.",
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
        description: "Prepara un archivo de texto UTF-8 en Escritorio, Descargas o cualquier carpeta dentro de la raíz de pc:/ usando workspace:/, downloads:/ o pc:/; nunca ejecuta el contenido y exige confirmación explícita antes de escribir.",
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
        description: "Prepara la aplicación de un parche unificado en Escritorio, Descargas o cualquier carpeta dentro de la raíz de pc:/ usando workspace:/, downloads:/ o pc:/. Usa hash de precondición y exige confirmación.",
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

    server.registerTool("run_command", {
        title: "Run a computer command",
        description: "Ejecuta un comando en Windows (PowerShell/CMD) o macOS/Linux (sh/bash/zsh). Puede leer o modificar cualquier recurso al que tenga acceso tu usuario. La primera llamada solo muestra el comando, directorio y token; nunca se ejecuta sin confirmed=true y ese confirmationToken.",
        inputSchema: {
            command: z.string().min(1).max(MAX_COMMAND_CHARS).refine((value) => !/[\0\r\n]/u.test(value), "El comando no puede contener NUL ni saltos de línea."),
            shell: z.enum(["powershell", "cmd", "bash", "zsh", "sh"]).default(DEFAULT_COMMAND_SHELL),
            cwd: pathSchema.optional(),
            timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => {
        try {
            const cwd = await controlCwd(services, args.cwd);
            return controlAction(services, extra, "run_command", {
                command: args.command,
                shell: args.shell,
                cwd,
                timeoutMs: args.timeoutMs,
            }, `Ejecutar ${args.shell} en ${cwd}: ${args.command}`, args.confirmationToken, args.confirmed, () => services.system.executeCommand({
                command: args.command,
                shell: args.shell,
                cwd,
                timeoutMs: args.timeoutMs,
                signal: extra.signal,
            }));
        }
        catch (error) {
            return failure(error);
        }
    });

    server.registerTool("launch_application", {
        title: "Launch a desktop application",
        description: "Abre un ejecutable o aplicación de Windows o macOS con argumentos separados. La acción requiere una vista previa y confirmación explícita; no interpreta argumentos como shell.",
        inputSchema: {
            executable: requiredPathSchema,
            arguments: z.array(z.string().max(MAX_ARGUMENT_CHARS).refine((value) => !/[\0\r\n]/u.test(value), "Los argumentos no pueden contener NUL ni saltos de línea.")).max(50).default([]),
            cwd: pathSchema.optional(),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => {
        try {
            const cwd = await controlCwd(services, args.cwd);
            return controlAction(services, extra, "launch_application", {
                executable: args.executable,
                arguments: args.arguments,
                cwd,
            }, `Abrir ${args.executable}${args.arguments.length === 0 ? "" : ` con ${args.arguments.length} argumento(s)`} en ${cwd}.`, args.confirmationToken, args.confirmed, () => services.system.launchApplication({
                executable: args.executable,
                arguments: args.arguments,
                cwd,
            }));
        }
        catch (error) {
            return failure(error);
        }
    });

    server.registerTool("open_item", {
        title: "Open a file or folder",
        description: "Abre un archivo o carpeta existente con la aplicación asociada del sistema. Solo acepta destinos que ManuMCP pueda autorizar y requiere confirmación.",
        inputSchema: {
            path: requiredPathSchema,
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => {
        try {
            const target = await existingControlTarget(services, args.path);
            return controlAction(services, extra, "open_item", { target }, `Abrir ${target} con la aplicación asociada del sistema.`, args.confirmationToken, args.confirmed, () => services.system.openItem({ target, signal: extra.signal }));
        }
        catch (error) {
            return failure(error);
        }
    });

    server.registerTool("open_url", {
        title: "Open a URL in the default browser",
        description: "Abre una URL HTTP/HTTPS en el navegador predeterminado de Windows, macOS o Linux. No acepta rutas de archivos, esquemas de código ni credenciales incrustadas; requiere vista previa y confirmación.",
        inputSchema: {
            url: browserUrlSchema,
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async (args, extra) => controlAction(services, extra, "open_url", {
        url: args.url,
    }, `Abrir ${args.url} en el navegador predeterminado.`, args.confirmationToken, args.confirmed, () => services.system.openUrl(args.url)));

    server.registerTool("list_processes", {
        title: "List computer processes",
        description: "Consulta los procesos activos de Windows o macOS y devuelve PID, nombre y memoria. No modifica nada.",
        inputSchema: {
            filter: z.string().max(256).optional(),
            maxEntries: z.number().int().min(1).max(500).default(100),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guarded(services, extra, () => services.system.listProcesses(args.filter, args.maxEntries)));

    server.registerTool("terminate_process", {
        title: "Terminate a computer process",
        description: "Termina un proceso de Windows o macOS por PID, opcionalmente con fuerza. Nunca se ejecuta sin vista previa y confirmación explícita.",
        inputSchema: {
            pid: z.number().int().min(1).max(4_000_000),
            force: z.boolean().default(false),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => controlAction(services, extra, "terminate_process", {
        pid: args.pid,
        force: args.force,
    }, `Terminar el proceso PID ${args.pid}${args.force ? " con fuerza" : ""}.`, args.confirmationToken, args.confirmed, () => services.system.terminateProcess(args.pid, args.force)));

    server.registerTool("list_windows", {
        title: "List visible windows",
        description: "Lista ventanas visibles de Windows o macOS con título, identificador y PID, e indica cuál está activa. No modifica nada.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, extra) => guarded(services, extra, () => services.system.listWindows()));

    server.registerTool("focus_window", {
        title: "Focus a desktop window",
        description: "Activa una ventana visible de Windows o macOS por su identificador. La primera llamada solo prepara la acción y la segunda exige confirmación explícita.",
        inputSchema: {
            handle: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => controlAction(services, extra, "focus_window", {
        handle: args.handle,
    }, `Activar la ventana ${args.handle}.`, args.confirmationToken, args.confirmed, () => services.system.focusWindow(args.handle)));

    server.registerTool("close_window", {
        title: "Close a desktop window",
        description: "Solicita el cierre normal de una ventana de Windows o macOS por su identificador. La aplicación puede pedir guardar cambios; no fuerza el cierre. Requiere confirmación explícita.",
        inputSchema: {
            handle: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => controlAction(services, extra, "close_window", {
        handle: args.handle,
    }, `Solicitar el cierre normal de la ventana ${args.handle}.`, args.confirmationToken, args.confirmed, () => services.system.closeWindow(args.handle)));

    server.registerTool("get_screen_info", {
        title: "List computer screens",
        description: "Consulta las pantallas de Windows o macOS y sus coordenadas para dirigir acciones de interfaz. No modifica nada.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, extra) => guarded(services, extra, () => services.system.getScreenInfo()));

    server.registerTool("capture_screen", {
        title: "Capture the computer screen",
        description: "Toma una captura PNG de la pantalla primaria, de una pantalla concreta o de todas. En macOS requiere Screen Recording. La imagen puede contener información sensible; úsalo solo cuando lo pidas explícitamente.",
        inputSchema: {
            screenIndex: z.number().int().min(0).max(16).optional(),
            allScreens: z.boolean().default(false),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (args, extra) => guardedContent(services, extra, async () => {
        const capture = await services.system.captureScreen(args.screenIndex, args.allScreens);
        return [
            { type: "image", data: capture.data, mimeType: capture.mimeType },
            { type: "text", text: JSON.stringify({ ok: true, width: capture.width, height: capture.height, screen: capture.screen }, null, 2) },
        ];
    }));

    server.registerTool("get_cursor_position", {
        title: "Get mouse position",
        description: "Devuelve la posición actual del cursor en coordenadas de pantalla. No modifica nada.",
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    }, async (_args, extra) => guarded(services, extra, () => services.system.getCursorPosition()));

    server.registerTool("control_mouse", {
        title: "Control the desktop mouse",
        description: "Mueve el cursor, hace clic o desplaza la rueda en coordenadas de pantalla de Windows o macOS. La primera llamada solo prepara la acción y la segunda exige confirmación explícita.",
        inputSchema: {
            action: z.enum(["move", "click", "scroll"]),
            x: z.number().int().min(-20_000).max(20_000).optional(),
            y: z.number().int().min(-20_000).max(20_000).optional(),
            button: z.enum(["left", "right", "middle"]).optional(),
            clicks: z.number().int().min(1).max(3).default(1),
            delta: z.number().int().min(-120_000).max(120_000).optional(),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => controlAction(services, extra, "control_mouse", {
        action: args.action,
        x: args.x,
        y: args.y,
        button: args.button,
        clicks: args.clicks,
        delta: args.delta,
    }, `Acción de ratón ${args.action} en (${args.x ?? "?"}, ${args.y ?? "?"}).`, args.confirmationToken, args.confirmed, () => services.system.controlMouse(args)));

    server.registerTool("type_text", {
        title: "Type text into the active window",
        description: "Escribe texto Unicode en la ventana activa mediante la entrada de teclado de Windows o macOS. La primera llamada solo prepara la acción y la segunda exige confirmación explícita.",
        inputSchema: {
            text: z.string().max(MAX_TYPED_TEXT_CHARS).refine((value) => !value.includes("\u0000"), "El texto no puede contener caracteres NUL."),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => controlAction(services, extra, "type_text", {
        text: args.text,
    }, `Escribir ${[...args.text].length} carácter(es) en la ventana activa.`, args.confirmationToken, args.confirmed, () => services.system.typeText(args.text)));

    server.registerTool("press_hotkey", {
        title: "Press a desktop hotkey",
        description: "Envía una combinación de teclas a la ventana activa. Usa CTRL/CONTROL, ALT/OPTION, SHIFT, CMD/WIN, ENTER, ESC, TAB, flechas, F1-F12 o letras/números. Requiere confirmación.",
        inputSchema: {
            keys: z.array(z.string().min(1).max(20)).min(1).max(6),
            confirmationToken: confirmationSchema,
            confirmed: z.boolean().default(false),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    }, async (args, extra) => {
        try {
            const codes = keyCodes(args.keys);
            return controlAction(services, extra, "press_hotkey", { keys: args.keys, codes }, `Pulsar la combinación ${args.keys.join("+")} en la ventana activa.`, args.confirmationToken, args.confirmed, () => services.system.hotkey(codes));
        }
        catch (error) {
            return failure(error);
        }
    });
}
