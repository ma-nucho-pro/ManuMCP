import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const DEFAULT_PORT = 8787;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
// On Windows the default roots are the user's real Desktop, Downloads and
// profile. The environment overrides remain available for narrower roots.
const DEFAULT_WORKSPACE_NAME = "Desktop";
const DEFAULT_DOWNLOADS_NAME = "Downloads";
const MAX_PORT = 65_535;
const PROTECTED_ROOT_SEGMENTS = new Set([
    ".aws",
    ".config",
    ".docker",
    ".git",
    ".gnupg",
    ".kube",
    ".ssh",
    "appdata",
    "program files",
    "program files (x86)",
    "programdata",
    "windows",
]);
function env(name) {
    const value = process.env[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
}
function positiveInteger(value, fallback, maximum, allowZero = false) {
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum)
        throw new Error(`La variable de entorno no es un entero válido: ${value}`);
    return parsed;
}
function profileFromEnvironment() {
    const value = env("MANUMCP_PROFILE") ?? "edit_safe";
    if (value !== "read_only" && value !== "edit_safe")
        throw new Error("MANUMCP_PROFILE debe ser read_only o edit_safe.");
    return value;
}
function resolvedPath(configured, fallback) {
    const resolved = path.resolve(configured ?? fallback);
    if (!path.isAbsolute(resolved))
        throw new Error("La ruta autorizada debe resolver a una ruta absoluta.");
    return resolved;
}
function assertSafeRoot(name, value) {
    const segments = value.split(/[\\/]+/u).filter((segment) => segment.length > 0);
    if (segments.some((segment) => PROTECTED_ROOT_SEGMENTS.has(segment.toLowerCase()))) {
        throw new Error(`${name} no puede apuntar a una carpeta protegida del sistema o de credenciales.`);
    }
    return value;
}
function samePath(left, right) {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === "win32"
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
function workspaceFromEnvironment() {
    return assertSafeRoot("MANUMCP_WORKSPACE", resolvedPath(env("MANUMCP_WORKSPACE"), path.join(os.homedir(), DEFAULT_WORKSPACE_NAME)));
}
function downloadsFromEnvironment() {
    return assertSafeRoot("MANUMCP_DOWNLOADS", resolvedPath(env("MANUMCP_DOWNLOADS"), path.join(os.homedir(), DEFAULT_DOWNLOADS_NAME)));
}
function pcRootFromEnvironment() {
    // This is the whole Windows user profile by default. It covers Desktop,
    // Downloads, Documents and other user-owned folders without exposing
    // Windows, Program Files or other users by accident. A deliberate
    // MANUMCP_PC_ROOT override can choose a different authorized directory.
    return assertSafeRoot("MANUMCP_PC_ROOT", resolvedPath(env("MANUMCP_PC_ROOT"), os.homedir()));
}
async function ensureDirectory(value) {
    try {
        const stat = await fs.stat(value);
        if (!stat.isDirectory())
            throw new Error(`La raíz autorizada no es un directorio: ${value}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        await fs.mkdir(value, { recursive: true });
    }
}
async function loadLocalToken() {
    const direct = env("MANUMCP_LOCAL_TOKEN");
    if (direct !== undefined)
        return direct;
    const tokenFile = env("MANUMCP_LOCAL_TOKEN_FILE");
    if (tokenFile === undefined)
        return undefined;
    try {
        const value = (await fs.readFile(path.resolve(tokenFile), "utf8")).trim();
        return value.length === 0 ? undefined : value;
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT")
            return undefined;
        throw new Error("No se pudo leer MANUMCP_LOCAL_TOKEN_FILE.");
    }
}
function confirmationKeyFromEnvironment() {
    const configured = env("MANUMCP_CONFIRMATION_KEY");
    if (configured === undefined)
        return crypto.randomBytes(32);
    // Hashing the configured value gives the token codec a fixed, strong key
    // without ever echoing the secret or requiring a particular encoding.
    return crypto.createHash("sha256").update(configured, "utf8").digest();
}
export async function loadConfig(mode) {
    const workspacePath = workspaceFromEnvironment();
    const downloadsPath = downloadsFromEnvironment();
    const pcPath = pcRootFromEnvironment();
    if (samePath(workspacePath, downloadsPath) || samePath(workspacePath, pcPath) || samePath(downloadsPath, pcPath)) {
        throw new Error("Las raíces de Escritorio, Descargas y pc:/ deben ser directorios distintos.");
    }
    await ensureDirectory(workspacePath);
    await ensureDirectory(downloadsPath);
    await ensureDirectory(pcPath);
    const profile = profileFromEnvironment();
    const port = positiveInteger(env("MANUMCP_PORT"), DEFAULT_PORT, MAX_PORT, true);
    const operationTimeoutMs = positiveInteger(env("MANUMCP_OPERATION_TIMEOUT_MS"), DEFAULT_OPERATION_TIMEOUT_MS, 120_000);
    const localToken = await loadLocalToken();
    if (mode === "http" && (localToken === undefined || localToken.length < 24)) {
        throw new Error("El modo HTTP exige MANUMCP_LOCAL_TOKEN (mínimo 24 caracteres) o MANUMCP_LOCAL_TOKEN_FILE.");
    }
    const configDirectory = path.join(os.homedir(), ".manumcp");
    const access = {
        profile,
        allowedRoots: [
            { alias: "workspace", path: workspacePath },
            { alias: "downloads", path: downloadsPath },
            { alias: "pc", path: pcPath },
        ],
        additionalDenyPatterns: [
            "**/.manumcp/**",
            "**/.manumcp-*",
            "**/*.env",
            "**/*.env.*",
            "**/AppData",
            "**/AppData/**",
            "**/Windows",
            "**/Windows/**",
            "**/Program Files",
            "**/Program Files/**",
            "**/Program Files (x86)",
            "**/Program Files (x86)/**",
            "**/ProgramData",
            "**/ProgramData/**",
            "**/System Volume Information",
            "**/System Volume Information/**",
            "**/$Recycle.Bin",
            "**/$Recycle.Bin/**",
            "**/Recovery",
            "**/Recovery/**",
            "**/PerfLogs",
            "**/PerfLogs/**",
            "**/NTUSER.*",
            "**/UsrClass.dat*",
            "**/.aws",
            "**/.aws/**",
            "**/.config",
            "**/.config/**",
            "**/.docker",
            "**/.docker/**",
            "**/.git",
            "**/.git/**",
            "**/.gnupg",
            "**/.gnupg/**",
            "**/.kube",
            "**/.kube/**",
            "**/.npmrc",
            "**/.pypirc",
            "**/.ssh",
            "**/.ssh/**",
            "**/.codex/**",
            "**/.local/state/tunnel-client/**",
        ],
        rejectAllSymlinks: true,
        rejectHardLinks: true,
        configFilePath: path.join(configDirectory, "config.json"),
        logging: {},
        limits: {
            maxPathLength: 1024,
            maxWriteBytes: 512 * 1024,
            maxWriteLines: 20_000,
            maxMoveBytes: 512 * 1024,
            confirmationTtlMs: 5 * 60 * 1000,
        },
    };
    return {
        name: "ManuMCP",
        version: "1.2.0",
        mode,
        workspacePath,
        workspaceAlias: "workspace",
        downloadsPath,
        downloadsAlias: "downloads",
        pcPath,
        pcAlias: "pc",
        profile,
        port,
        operationTimeoutMs,
        ...(localToken === undefined ? {} : { localToken }),
        confirmationKey: confirmationKeyFromEnvironment(),
        access,
    };
}
