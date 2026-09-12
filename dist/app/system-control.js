import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { TunnelGPTError } from "../core/errors.js";
const MAX_COMMAND_OUTPUT_BYTES = 128 * 1024;
const MAX_SCREEN_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_PROCESS_COUNT = 500;
const WINDOWS_POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
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
function unsupportedOnThisPlatform() {
    throw new TunnelGPTError("INVALID_ARGUMENT", "El control de procesos e interfaz solo está disponible en Windows.");
}
function outputError(file, error) {
    const message = error instanceof Error ? error.message : "Error desconocido.";
    return new TunnelGPTError("INTERNAL_ERROR", `No se pudo ejecutar ${file}.`, { reason: message.slice(0, 512) });
}
export class SystemControl {
    #config;
    #powershellPath;
    constructor(config) {
        this.#config = config;
        this.#powershellPath = path.join(process.env.SystemRoot ?? "C:\\Windows", WINDOWS_POWERSHELL);
    }
    async executeCommand(args) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        if (args.signal?.aborted === true)
            throw new TunnelGPTError("CANCELLED", "La ejecución fue cancelada antes de iniciarse.");
        const startedAt = Date.now();
        const commandScript = args.shell === "powershell"
            ? `$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8(args.command)}'))\n$global:LASTEXITCODE = 0\ntry { Invoke-Expression -Command $command; if ($null -ne $LASTEXITCODE) { exit [int]$LASTEXITCODE } } catch { $_ | Out-String | Write-Error; exit 1 }`
            : undefined;
        const executable = args.shell === "powershell" ? this.#powershellPath : "cmd.exe";
        const commandArgs = args.shell === "powershell"
            ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(commandScript)]
            : ["/d", "/s", "/c", args.command];
        const child = spawn(executable, commandArgs, {
            cwd: args.cwd,
            windowsHide: true,
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
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => append("stdout", chunk));
        child.stderr.on("data", (chunk) => append("stderr", chunk));
        const terminate = () => {
            if (process.platform === "win32" && child.pid !== undefined) {
                const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
                    windowsHide: true,
                    stdio: "ignore",
                });
                killer.unref();
            }
            try {
                child.kill();
            }
            catch {
            }
            forceTimer = setTimeout(() => {
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
            throw outputError(executable, error);
        }
        finally {
            clearTimeout(timeout);
            if (forceTimer !== undefined)
                clearTimeout(forceTimer);
            args.signal?.removeEventListener("abort", abort);
        }
    }
    async launchApplication(args) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn(args.executable, [...args.arguments], {
                    cwd: args.cwd,
                    detached: true,
                    windowsHide: false,
                    stdio: "ignore",
                });
            }
            catch (error) {
                reject(outputError(args.executable, error));
                return;
            }
            let spawned = false;
            child.once("error", (error) => {
                if (!spawned)
                    reject(outputError(args.executable, error));
            });
            child.once("spawn", () => {
                spawned = true;
                child.unref();
                resolve({ ok: true, pid: child.pid ?? null, executable: args.executable, arguments: args.arguments, cwd: args.cwd });
            });
        });
    }
    async openItem(args) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        const result = await this.launchApplication({ executable: "explorer.exe", arguments: [args.target], cwd: this.#config.pcPath });
        return { ok: true, target: args.target, pid: result.pid };
    }
    async listProcesses(filter, maxEntries) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
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
            processes.push({
                pid,
                name,
                ...(fields[2] === undefined ? {} : { session: fields[2] }),
                ...(fields[4] === undefined ? {} : { memory: fields[4] }),
            });
            if (processes.length >= maxEntries)
                break;
        }
        return { ok: true, processes, truncated: processes.length >= maxEntries };
    }
    async terminateProcess(pid, force) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        if (!Number.isSafeInteger(pid) || pid <= 4)
            throw new TunnelGPTError("INVALID_ARGUMENT", "Solo se pueden terminar procesos de usuario con PID mayor que 4.");
        if (pid === process.pid)
            throw new TunnelGPTError("INVALID_ARGUMENT", "ManuMCP no puede terminar su propio proceso.");
        const commandArgs = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
        const result = await this.runExecutable("taskkill.exe", commandArgs, false);
        if (result.exitCode !== 0) {
            throw new TunnelGPTError("INTERNAL_ERROR", "Windows no pudo terminar el proceso solicitado.", {
                pid,
                exitCode: result.exitCode,
                output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 1024),
            });
        }
        return { ok: true, pid, force, output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) };
    }
    async listWindows() {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
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
  public static WindowRecord[] List() {
    var rows = new List<WindowRecord>();
    var foreground = GetForegroundWindow();
    EnumWindows((handle, parameter) => {
      if (!IsWindowVisible(handle)) return true;
      var title = new StringBuilder(512);
      if (GetWindowText(handle, title, title.Capacity) <= 0 || title.Length == 0) return true;
      uint processId;
      GetWindowThreadProcessId(handle, out processId);
      rows.Add(new WindowRecord { handle = handle.ToInt64(), title = title.ToString(), pid = processId, active = handle == foreground });
      return true;
    }, IntPtr.Zero);
    return rows.ToArray();
  }
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
        let parsed;
        try {
            parsed = JSON.parse(output.stdout.trim() || "[]");
        }
        catch (error) {
            throw outputError(this.#powershellPath, error);
        }
        const windows = (Array.isArray(parsed) ? parsed : [parsed]);
        return { ok: true, windows };
    }
    async focusWindow(handle) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        const script = String.raw `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ManuMcpWindowFocus {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);
  public static bool Focus(long value) { var handle = new IntPtr(value); ShowWindow(handle, 5); return SetForegroundWindow(handle); }
}
'@
if (-not [ManuMcpWindowFocus]::Focus([long]${handle})) { throw 'No se pudo activar la ventana solicitada.' }
'focused'`;
        await this.runPowerShell(script, 64 * 1024);
        return { ok: true, handle };
    }
    async closeWindow(handle) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
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
    async getScreenInfo() {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        const script = String.raw `Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens
$items = @()
for ($index = 0; $index -lt $screens.Count; $index++) {
  $screen = $screens[$index]
  $items += [pscustomobject]@{
    index = $index
    name = $screen.DeviceName
    primary = [bool]$screen.Primary
    left = [int]$screen.Bounds.Left
    top = [int]$screen.Bounds.Top
    width = [int]$screen.Bounds.Width
    height = [int]$screen.Bounds.Height
  }
}
$items | ConvertTo-Json -Compress`;
        const output = await this.runPowerShell(script, 256 * 1024);
        let parsed;
        try {
            parsed = JSON.parse(output.stdout.trim());
        }
        catch (error) {
            throw outputError(this.#powershellPath, error);
        }
        const screens = (Array.isArray(parsed) ? parsed : [parsed]);
        return { ok: true, screens };
    }
    async captureScreen(screenIndex, allScreens) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        const index = screenIndex ?? -1;
        const script = String.raw `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$all = ${allScreens ? "$true" : "$false"}
$index = ${index}
if ($screens.Count -eq 0) { throw 'No hay pantallas disponibles.' }
if ($all) {
  $bounds = $screens[0].Bounds
  for ($cursor = 1; $cursor -lt $screens.Count; $cursor++) { $bounds = [System.Drawing.Rectangle]::Union($bounds, $screens[$cursor].Bounds) }
  $label = 'all'
}
elseif ($index -ge 0) {
  if ($index -ge $screens.Count) { throw 'El índice de pantalla no existe.' }
  $bounds = $screens[$index].Bounds
  $label = [string]$index
}
else {
  $primary = [System.Windows.Forms.Screen]::PrimaryScreen
  $bounds = $primary.Bounds
  $label = 'primary'
}
$bitmap = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $graphics.CopyFromScreen([int]$bounds.Left, [int]$bounds.Top, 0, 0, $bitmap.Size)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [pscustomobject]@{
    width = [int]$bounds.Width
    height = [int]$bounds.Height
    screen = $label
    data = [Convert]::ToBase64String($stream.ToArray())
  } | ConvertTo-Json -Compress
}
finally {
  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}`;
        const output = await this.runPowerShell(script, MAX_SCREEN_OUTPUT_BYTES);
        let parsed;
        try {
            parsed = JSON.parse(output.stdout.trim());
        }
        catch (error) {
            throw outputError(this.#powershellPath, error);
        }
        if (parsed === null || typeof parsed !== "object")
            throw new TunnelGPTError("INTERNAL_ERROR", "La captura de pantalla devolvió un formato inesperado.");
        const value = parsed;
        if (typeof value.data !== "string" || typeof value.width !== "number" || typeof value.height !== "number" || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height))
            throw new TunnelGPTError("INTERNAL_ERROR", "La captura de pantalla no contiene una imagen PNG válida.");
        const screen = value.screen === "all" || value.screen === "primary"
            ? value.screen
            : typeof value.screen === "string" && /^\d+$/u.test(value.screen)
                ? Number.parseInt(value.screen, 10)
                : "primary";
        return { data: value.data, mimeType: "image/png", width: value.width, height: value.height, screen };
    }
    async getCursorPosition() {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        const script = String.raw `Add-Type -AssemblyName System.Windows.Forms
$position = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{ x = [int]$position.X; y = [int]$position.Y } | ConvertTo-Json -Compress`;
        const output = await this.runPowerShell(script, 64 * 1024);
        return JSON.parse(output.stdout.trim());
    }
    async controlMouse(args) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
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
        const script = String.raw `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ManuMcpMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public static void Click(string button, int count) {
    uint down = button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u;
    uint up = button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u;
    for (int i = 0; i < count; i++) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  }
  public static void Scroll(int amount) { mouse_event(0x0800u, 0, 0, (uint)amount, UIntPtr.Zero); }
}
'@
[ManuMcpMouse]::SetCursorPos(${x}, ${y}) | Out-Null
if ('${args.action}' -eq 'click') { [ManuMcpMouse]::Click('${button}', ${clicks}) }
elseif ('${args.action}' -eq 'scroll') { [ManuMcpMouse]::Scroll(${delta}) }
Add-Type -AssemblyName System.Windows.Forms
$position = [System.Windows.Forms.Cursor]::Position
[pscustomobject]@{ x = [int]$position.X; y = [int]$position.Y } | ConvertTo-Json -Compress`;
        const output = await this.runPowerShell(script, 64 * 1024);
        return { ok: true, action: args.action, position: JSON.parse(output.stdout.trim()) };
    }
    async typeText(text) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        const encodedText = encodeUtf8(text);
        const script = String.raw `Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ManuMcpKeyboard {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Unicode(string value) {
    var inputs = new List<INPUT>();
    foreach (char character in value) {
      inputs.Add(new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = character, dwFlags = 0x0004u } } });
      inputs.Add(new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wScan = character, dwFlags = 0x0004u | 0x0002u } } });
    }
    if (inputs.Count > 0) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedText}'))
[ManuMcpKeyboard]::Unicode($text)`;
        await this.runPowerShell(script, 256 * 1024);
        return { ok: true, characters: [...text].length };
    }
    async hotkey(keys) {
        if (process.platform !== "win32")
            unsupportedOnThisPlatform();
        if (keys.length === 0 || keys.length > 6)
            throw new TunnelGPTError("INVALID_ARGUMENT", "Una combinación debe tener entre 1 y 6 teclas.");
        const keyValues = keys.join(",");
        const script = String.raw `Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ManuMcpHotkey {
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  static INPUT Key(ushort value, uint flags) => new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = value, dwFlags = flags } } };
  public static void Combo(ushort[] values) {
    var inputs = new List<INPUT>();
    foreach (var value in values) inputs.Add(Key(value, 0));
    for (int index = values.Length - 1; index >= 0; index--) inputs.Add(Key(values[index], 0x0002u));
    SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
[ManuMcpHotkey]::Combo([ushort[]]@(${keyValues}))`;
        await this.runPowerShell(script, 64 * 1024);
        return { ok: true, keys };
    }
    async runPowerShell(script, maxBuffer) {
        const result = await this.runExecutable(this.#powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(script)], true, maxBuffer);
        if (result.exitCode !== 0)
            throw new TunnelGPTError("INTERNAL_ERROR", "Windows PowerShell no pudo completar la operación.", { output: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2048) });
        return result;
    }
    async runExecutable(file, args, throwOnError = true, maxBuffer = 256 * 1024) {
        return new Promise((resolve, reject) => {
            execFile(file, [...args], { windowsHide: true, maxBuffer, encoding: "utf8" }, (error, stdout, stderr) => {
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
    const named = {
        BACKSPACE: 0x08,
        TAB: 0x09,
        ENTER: 0x0d,
        SHIFT: 0x10,
        CTRL: 0x11,
        CONTROL: 0x11,
        ALT: 0x12,
        PAUSE: 0x13,
        CAPSLOCK: 0x14,
        ESC: 0x1b,
        ESCAPE: 0x1b,
        SPACE: 0x20,
        PAGEUP: 0x21,
        PAGEDOWN: 0x22,
        END: 0x23,
        HOME: 0x24,
        LEFT: 0x25,
        UP: 0x26,
        RIGHT: 0x27,
        DOWN: 0x28,
        INSERT: 0x2d,
        DELETE: 0x2e,
        WIN: 0x5b,
        WINDOWS: 0x5b,
    };
    const namedValue = named[normalized];
    if (namedValue !== undefined)
        return namedValue;
    if (/^F(?:[1-9]|1[0-2])$/u.test(normalized))
        return 0x70 + Number.parseInt(normalized.slice(1), 10) - 1;
    if (/^[A-Z0-9]$/u.test(normalized))
        return normalized.charCodeAt(0);
    throw new TunnelGPTError("INVALID_ARGUMENT", `Tecla no reconocida: ${value}. Usa CTRL, ALT, SHIFT, WIN, ENTER, ESC, TAB, flechas, F1-F12 o una letra/número.`);
}
