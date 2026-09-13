import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileAccessConfig, Profile } from "../core/file-access-config.js";

const DEFAULT_PORT = 8787;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
// The default roots are the real Desktop, Downloads and the host filesystem
// root. Environment overrides remain available for narrower roots.
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
    "system",
    "library",
    "private",
    "windows",
]);

export interface ManuMcpConfig {
    readonly name: "ManuMCP";
    readonly version: string;
    readonly mode: "http" | "stdio";
    readonly workspacePath: string;
    readonly workspaceAlias: "workspace";
    readonly downloadsPath: string;
    readonly downloadsAlias: "downloads";
    readonly pcPath: string;
    readonly pcAlias: "pc";
    readonly profile: Profile;
    readonly port: number;
    readonly operationTimeoutMs: number;
    readonly localToken?: string;
    readonly confirmationKey: Buffer;
    readonly access: FileAccessConfig;
}

function env(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number, allowZero = false): number {
    if (value === undefined)
        return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > maximum)
        throw new Error(`La variable de entorno no es un entero válido: ${value}`);
    return parsed;
}

function profileFromEnvironment(): Profile {
    const value = env("MANUMCP_PROFILE") ?? "edit_safe";
    if (value !== "read_only" && value !== "edit_safe")
        throw new Error("MANUMCP_PROFILE debe ser read_only o edit_safe.");
    return value;
}

function resolvedPath(configured: string | undefined, fallback: string): string {
    const resolved = path.resolve(configured ?? fallback);
    if (!path.isAbsolute(resolved))
        throw new Error("La ruta autorizada debe resolver a una ruta absoluta.");
    return resolved;
}

function assertSafeRoot(name: string, value: string): string {
    const segments = value.split(/[\\/]+/u).filter((segment) => segment.length > 0);
    if (segments.some((segment) => PROTECTED_ROOT_SEGMENTS.has(segment.toLowerCase()))) {
        throw new Error(`${name} no puede apuntar a una carpeta protegida del sistema o de credenciales.`);
    }
    return value;
}

function samePath(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === "win32"
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}

function workspaceFromEnvironment(): string {
    return assertSafeRoot("MANUMCP_WORKSPACE", resolvedPath(env("MANUMCP_WORKSPACE"), path.join(os.homedir(), DEFAULT_WORKSPACE_NAME)));
}

function downloadsFromEnvironment(): string {
    return assertSafeRoot("MANUMCP_DOWNLOADS", resolvedPath(env("MANUMCP_DOWNLOADS"), path.join(os.homedir(), DEFAULT_DOWNLOADS_NAME)));
}

function defaultComputerRoot(): string {
    // path.parse() uses the host platform's path rules. This yields C:\ on
    // Windows and / on macOS/Linux, including every mounted Windows volume
    // when the runtime later discovers them.
    return path.parse(os.homedir()).root;
}

function pcRootFromEnvironment(): string {
    // The default is the complete host filesystem root. File tools still apply
    // their non-reducible deny policy, while commands run with the user's OS
    // permissions. A deliberate MANUMCP_PC_ROOT override can narrow it.
    return assertSafeRoot("MANUMCP_PC_ROOT", resolvedPath(env("MANUMCP_PC_ROOT"), defaultComputerRoot()));
}

function isWindowsDriveRoot(value: string): boolean {
    return process.platform === "win32" && /^[A-Za-z]:[\\/]$/u.test(value);
}

async function discoverWindowsVolumes(pcPath: string): Promise<readonly { alias: string; path: string }[]> {
    if (!isWindowsDriveRoot(pcPath))
        return [];
    const roots: { alias: string; path: string }[] = [];
    for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
        const letter = String.fromCharCode(code);
        const volumePath = `${letter}:\\`;
        try {
            const stat = await fs.stat(volumePath);
            if (!stat.isDirectory() || samePath(volumePath, pcPath))
                continue;
            roots.push({ alias: `pc-${letter.toLowerCase()}`, path: volumePath });
        }
        catch {
            // Unmounted, inaccessible and optical drives are not authorized.
        }
    }
    return roots;
}

async function ensureDirectory(value: string): Promise<void> {
    try {
        const stat = await fs.stat(value);
        if (!stat.isDirectory())
            throw new Error(`La raíz autorizada no es un directorio: ${value}`);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw error;
        await fs.mkdir(value, { recursive: true });
    }
}

async function loadLocalToken(): Promise<string | undefined> {
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
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT")
            return undefined;
        throw new Error("No se pudo leer MANUMCP_LOCAL_TOKEN_FILE.");
    }
}

function confirmationKeyFromEnvironment(): Buffer {
    const configured = env("MANUMCP_CONFIRMATION_KEY");
    if (configured === undefined)
        return crypto.randomBytes(32);
    // Hashing the configured value gives the token codec a fixed, strong key
    // without ever echoing the secret or requiring a particular encoding.
    return crypto.createHash("sha256").update(configured, "utf8").digest();
}

export async function loadConfig(mode: "http" | "stdio"): Promise<ManuMcpConfig> {
    const workspacePath = workspaceFromEnvironment();
    const downloadsPath = downloadsFromEnvironment();
    const pcPath = pcRootFromEnvironment();
    if (samePath(workspacePath, downloadsPath) || samePath(workspacePath, pcPath) || samePath(downloadsPath, pcPath)) {
        throw new Error("Las raíces de Escritorio, Descargas y pc:/ deben ser directorios distintos.");
    }
    await ensureDirectory(workspacePath);
    await ensureDirectory(downloadsPath);
    await ensureDirectory(pcPath);
    const volumeRoots = await discoverWindowsVolumes(pcPath);
    const profile = profileFromEnvironment();
    const port = positiveInteger(env("MANUMCP_PORT"), DEFAULT_PORT, MAX_PORT, true);
    const operationTimeoutMs = positiveInteger(env("MANUMCP_OPERATION_TIMEOUT_MS"), DEFAULT_OPERATION_TIMEOUT_MS, 120_000);
    const localToken = await loadLocalToken();
    if (mode === "http" && (localToken === undefined || localToken.length < 24)) {
        throw new Error("El modo HTTP exige MANUMCP_LOCAL_TOKEN (mínimo 24 caracteres) o MANUMCP_LOCAL_TOKEN_FILE.");
    }

    const configDirectory = path.join(os.homedir(), ".manumcp");
    const access: FileAccessConfig = {
        profile,
        allowedRoots: [
            { alias: "workspace", path: workspacePath },
            { alias: "downloads", path: downloadsPath },
            { alias: "pc", path: pcPath },
            ...volumeRoots,
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
            "**/System",
            "**/System/**",
            "**/Library",
            "**/Library/**",
            "**/private",
            "**/private/**",
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
        version: "1.5.3",
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
