import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const DEFAULT_PORT = 8787;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_WORKSPACE_NAME = "ManuMCP-Workspace";
const MAX_PORT = 65_535;
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
function workspaceFromEnvironment() {
    const configured = env("MANUMCP_WORKSPACE");
    const workspace = configured ?? path.join(os.homedir(), DEFAULT_WORKSPACE_NAME);
    const resolved = path.resolve(workspace);
    if (!path.isAbsolute(resolved))
        throw new Error("MANUMCP_WORKSPACE debe resolver a una ruta absoluta.");
    return resolved;
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
    await fs.mkdir(workspacePath, { recursive: true });
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
        allowedRoots: [{ alias: "workspace", path: workspacePath }],
        additionalDenyPatterns: [
            "**/.manumcp/**",
            "**/.manumcp-*",
            "**/*.env",
            "**/*.env.*",
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
        version: "1.0.0",
        mode,
        workspacePath,
        workspaceAlias: "workspace",
        profile,
        port,
        operationTimeoutMs,
        ...(localToken === undefined ? {} : { localToken }),
        confirmationKey: confirmationKeyFromEnvironment(),
        access,
    };
}
