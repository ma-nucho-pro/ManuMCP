import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TunnelGPTError } from "../core/errors.js";
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_SCREEN_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_PROCESS_COUNT = 500;
const WINDOWS_POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_EXPLORER = path.join(process.env.SystemRoot?.trim() || "C:\\Windows", "explorer.exe");
const MAC_OSASCRIPT = "/usr/bin/osascript";
const MAC_SCREENCAPTURE = "/usr/sbin/screencapture";
function encodePowerShell(script) {
    return Buffer.from(script, "utf16le").toString("base64");
}
function encodeUtf8(value) {
    return Buffer.from(value, "utf8").toString("base64");
}
function decodeCsvLine(line) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                field += '"';
                index += 1;
            }
            else {
                quoted = !quoted;
            }
        }
        else if (character === "," && !quoted) {
            fields.push(field);
            field = "";
        }
        else {
            field += character;
        }
    }
    fields.push(field);
    return fields;
}
function parsePid(value) {
    const pid = Number.parseInt(value.replace(/[^0-9]/gu, ""), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}
function unsupportedOnThisPlatform(capability) {
    throw new TunnelGPTError("INVALID_ARGUMENT", `${capability} no está disponible en ${process.platform}.`);
}
function outputError(file, error) {
    const message = error instanceof Error ? error.message : "Error desconocido.";
    return new TunnelGPTError("INTERNAL_ERROR", `No se pudo ejecutar ${file}.`, { reason: message.slice(0, 512) });
}
function parseJsonOutput(file, output, fallback) {
    try {
        return JSON.parse(output.trim() || JSON.stringify(fallback));
    }
    catch (error) {
        throw outputError(file, error);
    }
}
function readPngSize(data) {
    if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new TunnelGPTError("INTERNAL_ERROR", "La captura no devolvió un PNG válido.");
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
function macWindowParts(handle) {
    if (!Number.isSafeInteger(handle) || handle < 2_001)
        throw new TunnelGPTError("INVALID_ARGUMENT", "El identificador de ventana de macOS no es válido.");
    const index = handle % 1_000 - 1;
    const pid = Math.floor(handle / 1_000);
    if (pid <= 1 || index < 0 || index > 998)
        throw new TunnelGPTError("INVALID_ARGUMENT", "El identificador de ventana de macOS no es válido.");
    return { pid, index };
}
const MAC_LETTER_CODES = {
    A: 0, B: 11, C: 8, D: 2, E: 14, F: 3, G: 5, H: 4, I: 34, J: 38, K: 40, L: 37, M: 46,
    N: 45, O: 31, P: 35, Q: 12, R: 15, S: 1, T: 17, U: 32, V: 9, W: 13, X: 7, Y: 16, Z: 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
};
const WINDOWS_KEY_CODES = {
    BACKSPACE: 0x08, TAB: 0x09, ENTER: 0x0d, RETURN: 0x0d, SHIFT: 0x10, CTRL: 0x11, CONTROL: 0x11,
    ALT: 0x12, PAUSE: 0x13, CAPSLOCK: 0x14, ESC: 0x1b, ESCAPE: 0x1b, SPACE: 0x20, PAGEUP: 0x21,
    PAGEDOWN: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28,
    INSERT: 0x2d, DELETE: 0x2e, WIN: 0x5b, WINDOWS: 0x5b,
};
const MAC_KEY_CODES = {
    BACKSPACE: 51, TAB: 48, ENTER: 36, RETURN: 36, SHIFT: 56, CTRL: 59, CONTROL: 59, ALT: 58,
    OPTION: 58, CAPSLOCK: 57, ESC: 53, ESCAPE: 53, SPACE: 49, PAGEUP: 116, PAGEDOWN: 121,
    END: 119, HOME: 115, LEFT: 123, UP: 126, RIGHT: 124, DOWN: 125, INSERT: 114, DELETE: 117,
    CMD: 55, COMMAND: 55, META: 55, WIN: 55, WINDOWS: 55,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109,
    F11: 103, F12: 111,
};
export class SystemControl {
    #config;
    #powershellPath;
    constructor(config) {
        this.#config = config;
        this.#powershellPath = path.join(process.env.SystemRoot ?? "C:\\Windows", WINDOWS_POWERSHELL);
    }
    async executeCommand(args) {
        if (args.signal?.aborted === true)
            throw new TunnelGPTError("CANCELLED", "La ejecución fue cancelada antes de iniciarse.");
        const resolved = this.resolveCommand(args.shell, args.command);
        const startedAt = Date.now();
        const child = spawn(resolved.executable, [...resolved.arguments], {
            cwd: args.cwd,
            windowsHide: process.platform === "win32",
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let outputTruncated = false;
        let timedOut = false;
        let cancelled = false;
        let forceTimer;
        const append = (target, chunk) => {
            const remaining = MAX_COMMAND_OUTPUT_BYTES - outputBytes;
            const bytes = Buffer.byteLength(chunk, "utf8");
            if (remaining <= 0) {
                outputTruncated = true;
                return;
            }
            if (bytes <= remaining) {
                if (target === "stdout")
                    stdout += chunk;
                else
                    stderr += chunk;
                outputBytes += bytes;
                return;
            }
            const truncated = Buffer.from(chunk, "utf8").subarray(0, remaining).toString("utf8");
            if (target === "stdout")
                stdout += truncated;
            else
                stderr += truncated;
            outputBytes += Buffer.byteLength(truncated, "utf8");
            outputTruncated = true;
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => append("stdout", chunk));
        child.stderr?.on("data", (chunk) => append("stderr", chunk));
        const terminate = () => {
            if (process.platform === "win32" && child.pid !== undefined) {
                const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
                    windowsHide: true,
                    stdio: "ignore",
                });
                killer.unref();
            }
            else if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, "SIGTERM");
                }
                catch {
                }
            }
            try {
                child.kill();
            }
            catch {
            }
            forceTimer = setTimeout(() => {
                if (process.platform !== "win32" && child.pid !== undefined) {
                    try {
                        process.kill(-child.pid, "SIGKILL");
                    }
                    catch {
                    }
                }
                try {
                    child.kill("SIGKILL");
                }
                catch {
                }
            }, 1_000);
            forceTimer.unref();
        };
        const abort = () => {
            cancelled = true;
            terminate();
        };
        args.signal?.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(() => {
            timedOut = true;
            terminate();
        }, args.timeoutMs);
        timeout.unref();
        try {
            const close = await new Promise((resolve, reject) => {
                child.once("error", reject);
                child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
            });
            if (timedOut)
                throw new TunnelGPTError("TIMEOUT", "El comando superó el tiempo máximo permitido.");
            if (cancelled)
                throw new TunnelGPTError("CANCELLED", "La ejecución fue cancelada.");
            return {
                ok: true,
                shell: args.shell,
                command: args.command,
                cwd: args.cwd,
                exitCode: close.exitCode,
                signal: close.signal,
                timedOut,
                cancelled,
                durationMs: Date.now() - startedAt,
                stdout,
                stderr,
                outputTruncated,
            };
        }
        catch (error) {
            if (error instanceof TunnelGPTError)
                throw error;
            throw outputError(resolved.executable, error);
        }
        finally {
            clearTimeout(timeout);
            if (forceTimer !== undefined)
                clearTimeout(forceTimer);
            args.signal?.removeEventListener("abort", abort);
        }
    }
    async launchApplication(args) {
        if (process.platform === "darwin" && !args.executable.includes("/") && !args.executable.toLowerCase().endsWith(".app")) {
            const result = await this.runExecutable("/usr/bin/open", ["-a", args.executable, ...(args.arguments.length === 0 ? [] : ["--args", ...args.arguments])], false);
            if (result.exitCode !== 0)
                throw new TunnelGPTError("INTERNAL_ERROR", "macOS no pudo abrir la aplicación solicitada.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
            return { ok: true, pid: null, executable: args.executable, arguments: args.arguments, cwd: args.cwd };
        }
        if (process.platform === "darwin" && (args.executable.toLowerCase().endsWith(".app") || path.isAbsolute(args.executable))) {
            const result = await this.runExecutable("/usr/bin/open", [args.executable, ...(args.arguments.length === 0 ? [] : ["--args", ...args.arguments])], false);
            if (result.exitCode !== 0)
                throw new TunnelGPTError("INTERNAL_ERROR", "macOS no pudo abrir la aplicación solicitada.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
            return { ok: true, pid: null, executable: args.executable, arguments: args.arguments, cwd: args.cwd };
        }
        return this.spawnDetached(args.executable, args.arguments, args.cwd, args);
    }
    async openItem(args) {
        if (process.platform === "win32") {
            const result = await this.launchApplication({ executable: WINDOWS_EXPLORER, arguments: [args.target], cwd: this.#config.pcPath });
            return { ok: true, target: args.target, pid: result.pid };
        }
        const executable = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
        const result = await this.runExecutable(executable, [args.target], false);
        if (result.exitCode !== 0)
            throw new TunnelGPTError("INTERNAL_ERROR", "El sistema no pudo abrir el archivo o carpeta.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
        return { ok: true, target: args.target, pid: null };
    }
    async openUrl(url) {
        if (process.platform === "win32") {
            const result = await this.launchApplication({ executable: WINDOWS_EXPLORER, arguments: [url], cwd: this.#config.pcPath });
            return { ok: true, url, pid: result.pid };
        }
        const executable = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
        const result = await this.runExecutable(executable, [url], false);
        if (result.exitCode !== 0)
            throw new TunnelGPTError("INTERNAL_ERROR", "El sistema no pudo abrir la URL en el navegador predeterminado.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
        return { ok: true, url, pid: null };
    }
    async listProcesses(filter, maxEntries) {
        if (process.platform === "win32") {
            const raw = await this.runExecutable("tasklist.exe", ["/FO", "CSV", "/NH"]);
            const processes = [];
            const normalizedFilter = filter?.toLowerCase();
            for (const line of raw.stdout.split(/\r?\n/u)) {
                if (line.trim().length === 0)
                    continue;
                const fields = decodeCsvLine(line);
                const pid = fields[1] === undefined ? undefined : parsePid(fields[1]);
                const name = fields[0]?.trim();
                if (pid === undefined || name === undefined || name.length === 0)
                    continue;
                if (normalizedFilter !== undefined && !name.toLowerCase().includes(normalizedFilter))
                    continue;
                processes.push({ pid, name, ...(fields[2] === undefined ? {} : { session: fields[2] }), ...(fields[4] === undefined ? {} : { memory: fields[4] }) });
                if (processes.length >= maxEntries)
                    break;
            }
            return { ok: true, processes, truncated: processes.length >= maxEntries };
        }
        const raw = await this.runExecutable("/bin/ps", ["-axo", "pid=,comm=,state=,rss="]);
        const processes = [];
        const normalizedFilter = filter?.toLowerCase();
        for (const line of raw.stdout.split(/\r?\n/u)) {
            const match = /^\s*(\d+)\s+(.+?)\s+\S\s+(\d+)\s*$/u.exec(line);
            if (match === null)
                continue;
            const pid = Number.parseInt(match[1], 10);
            const name = match[2].trim();
            if (!Number.isSafeInteger(pid) || pid <= 0 || name.length === 0)
                continue;
            if (normalizedFilter !== undefined && !name.toLowerCase().includes(normalizedFilter))
                continue;
            processes.push({ pid, name, memory: `${match[3]} KB` });
            if (processes.length >= Math.min(maxEntries, MAX_PROCESS_COUNT))
                break;
        }
        return { ok: true, processes, truncated: processes.length >= maxEntries };
    }
    async terminateProcess(pid, force) {
        const minimum = process.platform === "win32" ? 4 : 1;
        if (!Number.isSafeInteger(pid) || pid <= minimum)
            throw new TunnelGPTError("INVALID_ARGUMENT", `Solo se pueden terminar procesos de usuario con PID mayor que ${minimum}.`);
        if (pid === process.pid)
            throw new TunnelGPTError("INVALID_ARGUMENT", "ManuMCP no puede terminar su propio proceso.");
        if (process.platform === "win32") {
            const commandArgs = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
            const result = await this.runExecutable("taskkill.exe", commandArgs, false);
            if (result.exitCode !== 0)
                throw new TunnelGPTError("INTERNAL_ERROR", "Windows no pudo terminar el proceso solicitado.", { pid, exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 1024) });
            return { ok: true, pid, force, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) };
        }
        const result = await this.runExecutable("/bin/kill", [force ? "-KILL" : "-TERM", String(pid)], false);
        if (result.exitCode !== 0)
            throw new TunnelGPTError("INTERNAL_ERROR", "El sistema no pudo terminar el proceso solicitado.", { pid, exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 1024) });
        return { ok: true, pid, force, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) };
    }
    async listStorageVolumes() {
        if (process.platform === "win32") {
            const volumes = this.#config.access.allowedRoots
                .filter((root) => root.alias === this.#config.pcAlias || root.alias.startsWith(`${this.#config.pcAlias}-`))
                .map((root) => ({ alias: root.alias, name: root.alias === this.#config.pcAlias ? `Unidad ${root.path.slice(0, 2)}` : `Unidad ${root.alias.slice(this.#config.pcAlias.length + 1).toUpperCase()}:`, path: root.path, accessPath: `${root.alias}:/`, mounted: true }));
            return { ok: true, volumes };
        }
        const volumes = [{ alias: this.#config.pcAlias, name: "Sistema de archivos del equipo", path: this.#config.pcPath, accessPath: `${this.#config.pcAlias}:/`, mounted: true }];
        if (process.platform === "darwin") {
            try {
                const entries = await fs.readdir("/Volumes", { withFileTypes: true });
                for (const entry of entries) {
                    if (!entry.isDirectory() || entry.isSymbolicLink())
                        continue;
                    const mountedPath = path.join("/Volumes", entry.name);
                    const relative = path.relative(this.#config.pcPath, mountedPath);
                    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
                        continue;
                    volumes.push({ alias: this.#config.pcAlias, name: entry.name, path: mountedPath, accessPath: `${this.#config.pcAlias}:/${mountedPath.slice(1)}`, mounted: true });
                }
            }
            catch {
            }
        }
        return { ok: true, volumes };
    }
    async listWindows() {
        if (process.platform === "win32")
            return this.listWindowsWindows();
        if (process.platform === "darwin") {
            const script = `const se = Application("System Events");\nconst rows = [];\nfor (const p of se.processes()) {\n  try {\n    if (p.backgroundOnly()) continue;\n    const pid = Number(p.unixId());\n    const windows = p.windows();\n    for (let index = 0; index < windows.length; index += 1) {\n      const title = String(windows[index].name() || "");\n      if (title.length === 0) continue;\n      rows.push({ handle: pid * 1000 + index + 1, title, pid, active: Boolean(p.frontmost()) && index === 0 });\n    }\n  } catch (_) {}\n}\nconsole.log(JSON.stringify(rows));`;
            const output = await this.runJxa(script, 512 * 1024);
            return { ok: true, windows: parseJsonOutput(MAC_OSASCRIPT, output.stdout, []) };
        }
        unsupportedOnThisPlatform("La enumeración de ventanas");
    }
    async focusWindow(handle) {
        if (process.platform === "win32") {
            const script = String.raw `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ManuMcpWindowFocus {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr processId);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint sourceThread, uint targetThread, bool attach);
  public static bool Focus(long value) {
    var handle = new IntPtr(value);
    if (handle == IntPtr.Zero) return false;
    var foreground = GetForegroundWindow();
    var currentThread = GetCurrentThreadId();
    var foregroundThread = foreground == IntPtr.Zero ? 0u : GetWindowThreadProcessId(foreground, IntPtr.Zero);
    var targetThread = GetWindowThreadProcessId(handle, IntPtr.Zero);
    var attachedForeground = false;
    var attachedTarget = false;
    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      ShowWindowAsync(handle, 5);
      BringWindowToTop(handle);
      SetForegroundWindow(handle);
      return GetForegroundWindow() == handle;
    }
    finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
'@
if (-not [ManuMcpWindowFocus]::Focus([long]${handle})) { throw 'No se pudo activar la ventana solicitada.' }
'focused'`;
            await this.runPowerShell(script, 64 * 1024);
            return { ok: true, handle };
        }
        if (process.platform === "darwin") {
            const parts = macWindowParts(handle);
            const script = `const wanted = ${JSON.stringify(parts)};\nconst se = Application("System Events");\nlet found = false;\nfor (const p of se.processes()) {\n  try {\n    if (Number(p.unixId()) !== wanted.pid) continue;\n    p.frontmost = true;\n    const w = p.windows()[wanted.index];\n    if (!w) throw new Error("La ventana ya no existe.");\n    try { w.actions.byName("AXRaise").perform(); } catch (_) {}\n    found = true;\n    break;\n  } catch (error) { throw error; }\n}\nif (!found) throw new Error("No se encontró el proceso de la ventana.");\nconsole.log("focused");`;
            await this.runJxa(script, 64 * 1024);
            return { ok: true, handle };
        }
        unsupportedOnThisPlatform("La activación de ventanas");
    }
    async closeWindow(handle) {
        if (process.platform === "win32") {
            const script = String.raw `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ManuMcpWindowClose {
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  public static bool Close(long value) { return PostMessage(new IntPtr(value), 0x0010u, IntPtr.Zero, IntPtr.Zero); }
}
'@
if (-not [ManuMcpWindowClose]::Close([long]${handle})) { throw 'No se pudo solicitar el cierre de la ventana.' }
'close-requested'`;
            await this.runPowerShell(script, 64 * 1024);
            return { ok: true, handle };
        }
        if (process.platform === "darwin") {
            const parts = macWindowParts(handle);
            const script = `const wanted = ${JSON.stringify(parts)};\nconst se = Application("System Events");\nlet found = false;\nfor (const p of se.processes()) {\n  try {\n    if (Number(p.unixId()) !== wanted.pid) continue;\n    const w = p.windows()[wanted.index];\n    if (!w) throw new Error("La ventana ya no existe.");\n    let closed = false;\n    try { w.actions.byName("AXClose").perform(); closed = true; } catch (_) {}\n    if (!closed) { try { w.actions.byName("AXPress").perform(); closed = true; } catch (_) {} }\n    if (!closed) throw new Error("macOS no expuso una acción de cierre para la ventana.");\n    found = true;\n    break;\n  } catch (error) { throw error; }\n}\nif (!found) throw new Error("No se encontró el proceso de la ventana.");\nconsole.log("close-requested");`;
            await this.runJxa(script, 64 * 1024);
            return { ok: true, handle };
        }
        unsupportedOnThisPlatform("El cierre de ventanas");
    }
    async getScreenInfo() {
        if (process.platform === "win32") {
            const script = String.raw `Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$items = @()
for ($index = 0; $index -lt $screens.Count; $index++) {
  $screen = $screens[$index]
  $items += [pscustomobject]@{ index = $index; name = $screen.DeviceName; primary = [bool]$screen.Primary; left = [int]$screen.Bounds.Left; top = [int]$screen.Bounds.Top; width = [int]$screen.Bounds.Width; height = [int]$screen.Bounds.Height }
}
$items | ConvertTo-Json -Compress`;
            const output = await this.runPowerShell(script, 256 * 1024);
            const parsed = parseJsonOutput(this.#powershellPath, output.stdout, []);
            return { ok: true, screens: Array.isArray(parsed) ? parsed : [parsed] };
        }
        if (process.platform === "darwin") {
            const raw = await this.runExecutable("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], true, 4 * 1024 * 1024);
            const parsed = parseJsonOutput("/usr/sbin/system_profiler", raw.stdout, {});
            const screens = [];
            const visit = (value) => {
                if (Array.isArray(value)) {
                    for (const item of value)
                        visit(item);
                    return;
                }
                if (value === null || typeof value !== "object")
                    return;
                const record = value;
                const resolution = record.spdisplays_pixelresolution;
                if (typeof resolution === "string") {
                    const match = /(\d+)\s*[x×]\s*(\d+)/iu.exec(resolution);
                    if (match !== null) {
                        screens.push({ index: screens.length, name: String(record._name ?? record["spdisplays_display-product-name"] ?? `Display ${screens.length + 1}`), primary: screens.length === 0, left: 0, top: 0, width: Number.parseInt(match[1], 10), height: Number.parseInt(match[2], 10) });
                    }
                }
                for (const child of Object.values(record))
                    visit(child);
            };
            visit(parsed);
            if (screens.length === 0)
                throw new TunnelGPTError("INTERNAL_ERROR", "macOS no devolvió información de sus pantallas.");
            return { ok: true, screens };
        }
        unsupportedOnThisPlatform("La información de pantallas");
    }
    async captureScreen(screenIndex, allScreens) {
        if (process.platform === "win32")
            return this.captureScreenWindows(screenIndex, allScreens);
        if (process.platform !== "darwin")
            unsupportedOnThisPlatform("La captura de pantalla");
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manumcp-capture-"));
        const outputPath = path.join(directory, "screen.png");
        try {
            const argumentsValue = ["-x", "-t", "png"];
            if (allScreens)
                argumentsValue.push(outputPath);
            else if (screenIndex !== undefined)
                argumentsValue.push("-D", String(screenIndex + 1), outputPath);
            else
                argumentsValue.push("-m", outputPath);
            const result = await this.runExecutable(MAC_SCREENCAPTURE, argumentsValue, false, 64 * 1024);
            if (result.exitCode !== 0)
                throw new TunnelGPTError("INTERNAL_ERROR", "macOS no pudo capturar la pantalla. Concede Screen Recording a la aplicación que ejecuta ManuMCP.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
            const data = await fs.readFile(outputPath);
            if (data.length > MAX_SCREEN_OUTPUT_BYTES)
                throw new TunnelGPTError("LIMIT_EXCEEDED", "La captura supera el tamaño máximo permitido.");
            const size = readPngSize(data);
            return { data: data.toString("base64"), mimeType: "image/png", width: size.width, height: size.height, screen: allScreens ? "all" : screenIndex === undefined ? "primary" : screenIndex };
        }
        finally {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
    async getCursorPosition() {
        if (process.platform === "win32") {
            const script = String.raw `Add-Type -AssemblyName System.Windows.Forms
$position = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{ x = [int]$position.X; y = [int]$position.Y } | ConvertTo-Json -Compress`;
            const output = await this.runPowerShell(script, 64 * 1024);
            return parseJsonOutput(this.#powershellPath, output.stdout, { ok: true, x: 0, y: 0 });
        }
        if (process.platform === "darwin") {
            const output = await this.runJxa(`ObjC.import("CoreGraphics");\nconst event = $.CGEventCreate(null);\nconst point = $.CGEventGetLocation(event);\nconsole.log(JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }));`, 64 * 1024);
            return parseJsonOutput(MAC_OSASCRIPT, output.stdout, { ok: true, x: 0, y: 0 });
        }
        unsupportedOnThisPlatform("La posición del cursor");
    }
    async controlMouse(args) {
        if (args.action === "move" && (args.x === undefined || args.y === undefined))
            throw new TunnelGPTError("INVALID_ARGUMENT", "La acción move exige x e y.");
        if (args.action === "click" && (args.x === undefined || args.y === undefined || args.button === undefined))
            throw new TunnelGPTError("INVALID_ARGUMENT", "La acción click exige x, y y button.");
        if (args.action === "scroll" && (args.x === undefined || args.y === undefined || args.delta === undefined))
            throw new TunnelGPTError("INVALID_ARGUMENT", "La acción scroll exige x, y y delta.");
        const x = args.x ?? 0;
        const y = args.y ?? 0;
        const button = args.button ?? "left";
        const clicks = args.clicks ?? 1;
        const delta = args.delta ?? 0;
        if (process.platform === "win32") {
            const script = String.raw `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ManuMcpMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(string button, int count) { uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u; uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u; for (int i = 0; i < count; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); } }
  public static void Scroll(int amount) { mouse_event(0x0800u, 0, 0, (uint)amount, UIntPtr.Zero); }
}
'@
[ManuMcpMouse]::SetCursorPos(${x}, ${y}) | Out-Null
if ('${args.action}' -eq 'click') { [ManuMcpMouse]::Click('${button}', ${clicks}) } elseif ('${args.action}' -eq 'scroll') { [ManuMcpMouse]::Scroll(${delta}) }
Add-Type -AssemblyName System.Windows.Forms
$position = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{ x = [int]$position.X; y = [int]$position.Y } | ConvertTo-Json -Compress`;
            const output = await this.runPowerShell(script, 64 * 1024);
            return { ok: true, action: args.action, position: parseJsonOutput(this.#powershellPath, output.stdout, { x, y }) };
        }
        if (process.platform === "darwin") {
            const payload = JSON.stringify({ action: args.action, x, y, button, clicks, delta });
            const script = `ObjC.import("CoreGraphics");\nconst payload = ${payload};\nconst point = $.CGPointMake(payload.x, payload.y);\nconst button = payload.button === "right" ? $.kCGMouseButtonRight : payload.button === "middle" ? $.kCGMouseButtonCenter : $.kCGMouseButtonLeft;\nconst move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, button);\n$.CGEventPost($.kCGHIDEventTap, move);\nif (payload.action === "scroll") { const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, payload.delta); $.CGEventPost($.kCGHIDEventTap, event); } else if (payload.action === "click") { const downType = payload.button === "right" ? $.kCGEventRightMouseDown : payload.button === "middle" ? $.kCGEventOtherMouseDown : $.kCGEventLeftMouseDown; const upType = payload.button === "right" ? $.kCGEventRightMouseUp : payload.button === "middle" ? $.kCGEventOtherMouseUp : $.kCGEventLeftMouseUp; for (let index = 0; index < payload.clicks; index += 1) { const down = $.CGEventCreateMouseEvent(null, downType, point, button); const up = $.CGEventCreateMouseEvent(null, upType, point, button); $.CGEventPost($.kCGHIDEventTap, down); $.CGEventPost($.kCGHIDEventTap, up); } }\nconsole.log(JSON.stringify({ x: payload.x, y: payload.y }));`;
            const output = await this.runJxa(script, 64 * 1024);
            return { ok: true, action: args.action, position: parseJsonOutput(MAC_OSASCRIPT, output.stdout, { x, y }) };
        }
        unsupportedOnThisPlatform("El control del ratón");
    }
    async typeText(text) {
        if (process.platform === "win32") {
            const encodedText = encodeUtf8(text);
            const script = String.raw `Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ManuMcpKeyboard {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Unicode(string value) { var inputs = new List<INPUT>(); foreach (char character in value) { inputs.Add(new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = character, dwFlags = 0x0004u } } }); inputs.Add(new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = character, dwFlags = 0x0004u | 0x0002u } } }); } if (inputs.Count > 0) { var sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))); if (sent != (uint)inputs.Count) throw new InvalidOperationException("SendInput solo aceptó " + sent + " de " + inputs.Count + " entrada(s); error " + Marshal.GetLastWin32Error() + "."); } }
}
'@
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))
[ManuMcpKeyboard]::Unicode($text)`;
            await this.runPowerShell(script, 256 * 1024);
            return { ok: true, characters: [...text].length };
        }
        if (process.platform === "darwin") {
            const script = `ObjC.import("CoreGraphics");\nconst text = ${JSON.stringify(text)};\nconst down = $.CGEventCreateKeyboardEvent(null, 0, true);\n$.CGEventKeyboardSetUnicodeString(down, text.length, text);\n$.CGEventPost($.kCGHIDEventTap, down);\nconst up = $.CGEventCreateKeyboardEvent(null, 0, false);\n$.CGEventKeyboardSetUnicodeString(up, text.length, text);\n$.CGEventPost($.kCGHIDEventTap, up);\nconsole.log("typed");`;
            await this.runJxa(script, 64 * 1024);
            return { ok: true, characters: [...text].length };
        }
        unsupportedOnThisPlatform("La escritura de texto");
    }
    async hotkey(keys) {
        if (keys.length === 0 || keys.length > 6)
            throw new TunnelGPTError("INVALID_ARGUMENT", "Una combinación debe tener entre 1 y 6 teclas.");
        if (process.platform === "win32") {
            const keyValues = keys.join(",");
            const script = String.raw `Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ManuMcpHotkey {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  static INPUT Key(ushort value, uint flags) { return new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = value, dwFlags = flags } } }; }
  public static void Combo(ushort[] values) { var inputs = new List<INPUT>(); foreach (var value in values) inputs.Add(Key(value, 0)); for (int index = values.Length - 1; index >= 0; index--) inputs.Add(Key(values[index], 0x0002u)); var sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))); if (sent != (uint)inputs.Count) throw new InvalidOperationException("SendInput solo aceptó " + sent + " de " + inputs.Count + " entrada(s); error " + Marshal.GetLastWin32Error() + "."); }
}
'@
[ManuMcpHotkey]::Combo([UInt16[]]@(${keyValues}))`;
            await this.runPowerShell(script, 64 * 1024);
            return { ok: true, keys };
        }
        if (process.platform === "darwin") {
            const script = `ObjC.import("CoreGraphics");\nconst keys = ${JSON.stringify(keys)};\nfor (const code of keys) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateKeyboardEvent(null, code, true)); }\nfor (let index = keys.length - 1; index >= 0; index -= 1) { $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateKeyboardEvent(null, keys[index], false)); }\nconsole.log("pressed");`;
            await this.runJxa(script, 64 * 1024);
            return { ok: true, keys };
        }
        unsupportedOnThisPlatform("Las combinaciones de teclado");
    }
    resolveCommand(shell, command) {
        if (process.platform === "win32") {
            if (shell === "powershell") {
                const commandScript = `$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8(command)}'))\n$global:LASTEXITCODE = 0\ntry { Invoke-Expression -Command $command; if ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE } } catch { $_ | Out-String | Write-Error; exit 1 }`;
                return { executable: this.#powershellPath, arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(commandScript)] };
            }
            if (shell === "cmd")
                return { executable: "cmd.exe", arguments: ["/d", "/s", "/c", command] };
            throw new TunnelGPTError("INVALID_ARGUMENT", "En Windows usa powershell o cmd como shell.");
        }
        if (shell === "cmd")
            throw new TunnelGPTError("INVALID_ARGUMENT", "cmd solo está disponible en Windows.");
        if (shell === "powershell")
            return { executable: process.env.MANUMCP_PWSH?.trim() || "pwsh", arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(command)] };
        const executable = `/bin/${shell}`;
        return { executable, arguments: ["-lc", command] };
    }
    async spawnDetached(file, argumentsValue, cwd, original) {
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(file, [...argumentsValue], { cwd, detached: true, windowsHide: process.platform === "win32", stdio: "ignore" });
            }
            catch (error) {
                reject(outputError(file, error));
                return;
            }
            let spawned = false;
            child.once("error", (error) => {
                if (!spawned)
                    reject(outputError(file, error));
            });
            child.once("spawn", () => {
                spawned = true;
                child.unref();
                resolve({ ok: true, pid: child.pid ?? null, executable: original.executable, arguments: original.arguments, cwd: original.cwd });
            });
        });
    }
    async listWindowsWindows() {
        const script = String.raw `Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ManuMcpWindows {
  delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public sealed class WindowRecord { public long handle; public string title = ""; public uint pid; public bool active; }
  public static WindowRecord[] List() { var rows = new List<WindowRecord>(); var foreground = GetForegroundWindow(); EnumWindows((handle, parameter) => { if (!IsWindowVisible(handle)) return true; var title = new StringBuilder(512); if (GetWindowText(handle, title, title.Capacity) <= 0 || title.Length == 0) return true; uint processId; GetWindowThreadProcessId(handle, out processId); rows.Add(new WindowRecord { handle = handle.ToInt64(), title = title.ToString(), pid = processId, active = handle == foreground }); return true; }, IntPtr.Zero); return rows.ToArray(); }
  public static bool Focus(long value) { var handle = new IntPtr(value); ShowWindow(handle, 5); return SetForegroundWindow(handle); }
  public static bool Close(long value) { return PostMessage(new IntPtr(value), 0x0010u, IntPtr.Zero, IntPtr.Zero); }
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$rows = [ManuMcpWindows]::List()
if ($null -eq $rows) { '[]' } else { @($rows) | ConvertTo-Json -Compress }`;
        const output = await this.runPowerShell(script, 512 * 1024);
        const parsed = parseJsonOutput(this.#powershellPath, output.stdout, []);
        return { ok: true, windows: Array.isArray(parsed) ? parsed : [parsed] };
    }
    async captureScreenWindows(screenIndex, allScreens) {
        const index = screenIndex ?? -1;
        const script = String.raw `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$all = ${allScreens ? "$true" : "$false"}
$index = ${index}
if ($screens.Count -eq 0) { throw 'No hay pantallas disponibles.' }
if ($all) { $bounds = $screens[0].Bounds; for ($cursor = 1; $cursor -lt $screens.Count; $cursor++) { $bounds = [System.Drawing.Rectangle]::Union($bounds, $screens[$cursor].Bounds) }; $label = 'all' }
elseif ($index -ge 0) { if ($index -ge $screens.Count) { throw 'El índice de pantalla no existe.' }; $bounds = $screens[$index].Bounds; $label = [string]$index }
else { $primary = [System.Windows.Forms.Screen]::PrimaryScreen; $bounds = $primary.Bounds; $label = 'primary' }
$bitmap = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try { $graphics.CopyFromScreen([int]$bounds.Left, [int]$bounds.Top, 0, 0, $bitmap.Size); $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [pscustomobject]@{ width = [int]$bounds.Width; height = [int]$bounds.Height; screen = $label; data = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress }
finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }`;
        const output = await this.runPowerShell(script, MAX_SCREEN_OUTPUT_BYTES);
        const parsed = parseJsonOutput(this.#powershellPath, output.stdout, {});
        if (typeof parsed.data !== "string" || typeof parsed.width !== "number" || typeof parsed.height !== "number" || !Number.isSafeInteger(parsed.width) || !Number.isSafeInteger(parsed.height))
            throw new TunnelGPTError("INTERNAL_ERROR", "La captura de pantalla no contiene una imagen PNG válida.");
        const screen = parsed.screen === "all" || parsed.screen === "primary" ? parsed.screen : typeof parsed.screen === "string" && /^\d+$/u.test(parsed.screen) ? Number.parseInt(parsed.screen, 10) : "primary";
        return { data: parsed.data, mimeType: "image/png", width: parsed.width, height: parsed.height, screen };
    }
    async runJxa(script, maxBuffer) {
        if (process.platform !== "darwin")
            unsupportedOnThisPlatform("AppleScript/JXA");
        return this.runExecutable(MAC_OSASCRIPT, ["-l", "JavaScript", "-e", script], true, maxBuffer);
    }
    async runPowerShell(script, maxBuffer) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform("Windows PowerShell");
        const result = await this.runExecutable(this.#powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], true, maxBuffer);
        if (result.exitCode !== 0)
            throw new TunnelGPTError("INTERNAL_ERROR", "Windows PowerShell no pudo completar la operación.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
        return result;
    }
    async runExecutable(file, argumentsValue, throwOnError = true, maxBuffer = 256 * 1024) {
        return new Promise((resolve, reject) => {
            execFile(file, [...argumentsValue], { windowsHide: process.platform === "win32", maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
                const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : null;
                const result = { stdout: String(stdout), stderr: String(stderr), exitCode };
                if (throwOnError && error !== null)
                    reject(outputError(file, error));
                else
                    resolve(result);
            });
        });
    }
}
export function keyCodeFromName(value) {
    const normalized = value.trim().toUpperCase();
    if (process.platform === "darwin") {
        const namedValue = MAC_KEY_CODES[normalized];
        if (namedValue !== undefined)
            return namedValue;
        const letterValue = MAC_LETTER_CODES[normalized];
        if (letterValue !== undefined)
            return letterValue;
    }
    else {
        const namedValue = WINDOWS_KEY_CODES[normalized];
        if (namedValue !== undefined)
            return namedValue;
        if (/^F(?:[1-9]|1[0-2])$/u.test(normalized))
            return 0x70 + Number.parseInt(normalized.slice(1), 10) - 1;
        if (/^[A-Z0-9]$/u.test(normalized))
            return normalized.charCodeAt(0);
    }
    throw new TunnelGPTError("INVALID_ARGUMENT", `Tecla no reconocida: ${value}. Usa CTRL/CONTROL, ALT/OPTION, SHIFT, CMD/WIN, ENTER, ESC, TAB, flechas, F1-F12 o una letra/número.`);
}
