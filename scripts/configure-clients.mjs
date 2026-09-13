#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(process.env.MANUMCP_PROJECT_ROOT || path.join(scriptDirectory, '..'));
const chatGptSettingsUrl = 'https://chatgpt.com/#settings/Apps';
const supportedClients = ['codex', 'claude', 'gemini', 'cursor'];

function parseArguments(argv) {
    const result = {
        clients: [],
        dryRun: false,
        openChatGpt: false,
        replace: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--client') {
            const value = argv[index + 1];
            if (!value) throw new Error('--client necesita auto, codex, claude, gemini, cursor o none.');
            result.clients.push(...value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
            index += 1;
        }
        else if (argument === '--dry-run') result.dryRun = true;
        else if (argument === '--open-chatgpt') result.openChatGpt = true;
        else if (argument === '--replace') result.replace = true;
        else if (argument === '--help' || argument === '-h') result.help = true;
        else throw new Error(`Argumento no reconocido: ${argument}`);
    }
    return result;
}

function printHelp() {
    console.log(`Uso: node scripts/configure-clients.mjs [opciones]

Opciones:
  --client auto              Configura los clientes instalados (predeterminado).
  --client codex,claude      Configura solo los clientes indicados.
  --client cursor            Fusiona la entrada en ~/.cursor/mcp.json.
  --client none              No modifica clientes; solo muestra el comando stdio.
  --replace                  Reemplaza solo la entrada existente llamada manumcp.
  --dry-run                  Muestra las acciones sin escribir ni ejecutar comandos.
  --open-chatgpt             Abre ChatGPT web y muestra el paso de autorización manual.
`);
}

function executableOnPath(name) {
    const pathValue = process.env.PATH || '';
    const entries = pathValue.split(path.delimiter).filter(Boolean);
    const candidates = process.platform === 'win32'
        ? [name, `${name}.cmd`, `${name}.exe`, `${name}.bat`]
        : [name];
    for (const directory of entries) {
        for (const candidate of candidates) {
            const fullPath = path.join(directory, candidate);
            try {
                if (fs.statSync(fullPath).isFile()) return fullPath;
            }
            catch {
                // Sigue buscando en el resto del PATH.
            }
        }
    }
    return null;
}

function powershellExecutable() {
    if (process.platform !== 'win32') return null;
    const systemPowerShell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : null;
    if (systemPowerShell && fs.existsSync(systemPowerShell)) return systemPowerShell;
    return executableOnPath('pwsh') || executableOnPath('powershell') || 'powershell.exe';
}

function configuredStdioTarget() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        const wrapper = path.join(appData, 'ManuMCP', 'stdio-entrypoint.ps1');
        if (fs.existsSync(wrapper)) {
            return {
                command: powershellExecutable(),
                args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
                description: 'wrapper persistente de ManuMCP en PowerShell',
            };
        }
    }
    else {
        const wrapper = path.join(projectRoot, 'scripts', 'stdio-entrypoint-unix.sh');
        if (fs.existsSync(wrapper)) {
            return {
                command: executableOnPath('bash') || '/bin/bash',
                args: [wrapper],
                description: 'wrapper persistente de ManuMCP en Bash',
            };
        }
    }

    const entryPoint = path.join(projectRoot, 'dist', 'app', 'server.js');
    if (!fs.existsSync(entryPoint)) {
        throw new Error(`No existe ${entryPoint}. Ejecuta primero el instalador de ManuMCP.`);
    }
    return {
        command: process.execPath,
        args: [entryPoint, '--stdio'],
        description: 'servidor ManuMCP directo por stdio',
    };
}

function quoteForDisplay(value) {
    if (/^[A-Za-z0-9_./:=+-]+$/u.test(value)) return value;
    return JSON.stringify(value);
}

function displayCommand(command, args) {
    return [command, ...args].map(quoteForDisplay).join(' ');
}

function spawnOptions(command) {
    return {
        stdio: 'inherit',
        windowsHide: true,
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command),
    };
}

function runCommand(command, args, {dryRun = false, timeoutMs = 120_000} = {}) {
    const rendered = displayCommand(command, args);
    if (dryRun) {
        console.log(`DRY-RUN  ${rendered}`);
        return Promise.resolve(0);
    }
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, spawnOptions(command));
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new Error(`Tiempo agotado ejecutando: ${rendered}`));
        }, timeoutMs);
        child.once('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(typeof code === 'number' ? code : 1 + (signal ? 1 : 0));
        });
    });
}

function captureCommand(command, args, timeoutMs = 15_000) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command),
    });
    return {
        ok: result.status === 0,
        output: `${result.stdout || ''}\n${result.stderr || ''}`,
    };
}

function cursorConfigPath() {
    return process.env.MANUMCP_CURSOR_CONFIG || path.join(os.homedir(), '.cursor', 'mcp.json');
}

async function mergeCursorConfig(target, {dryRun, replace}) {
    const file = cursorConfigPath();
    let config = {};
    let originalText = '';
    if (fs.existsSync(file)) {
        originalText = await fsp.readFile(file, 'utf8');
        try {
            config = JSON.parse(originalText);
        }
        catch (error) {
            throw new Error(`No se pudo analizar ${file} como JSON: ${error.message}`);
        }
        if (config === null || Array.isArray(config) || typeof config !== 'object') {
            throw new Error(`${file} debe contener un objeto JSON.`);
        }
    }
    const servers = config.mcpServers ?? {};
    if (servers === null || Array.isArray(servers) || typeof servers !== 'object') {
        throw new Error(`${file} tiene una propiedad mcpServers que no es un objeto.`);
    }
    if (Object.prototype.hasOwnProperty.call(servers, 'manumcp') && !replace) {
        return {status: 'already-present', path: file, detail: 'ya existe; no se sobrescribió (usa --replace para actualizarlo)'};
    }
    const nextConfig = {
        ...config,
        mcpServers: {
            ...servers,
            manumcp: {
                type: 'stdio',
                command: target.command,
                args: target.args,
            },
        },
    };
    const nextText = `${JSON.stringify(nextConfig, null, 2)}\n`;
    if (nextText === originalText) return {status: 'already-current', path: file};
    if (dryRun) {
        console.log(`DRY-RUN  escribiría ${file} y conservaría los demás servidores MCP`);
        return {status: 'would-write', path: file};
    }
    await fsp.mkdir(path.dirname(file), {recursive: true});
    if (originalText) {
        const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
        await fsp.writeFile(backup, originalText, {encoding: 'utf8', mode: 0o600});
        console.log(`Cursor: respaldo creado en ${backup}`);
    }
    await fsp.writeFile(file, nextText, {encoding: 'utf8', mode: 0o600});
    return {status: 'configured', path: file};
}

const cliDefinitions = {
    codex: {executable: 'codex', listArgs: ['mcp', 'list'], addArgs: (target) => ['mcp', 'add', 'manumcp', '--', target.command, ...target.args], removeArgs: ['mcp', 'remove', 'manumcp']},
    claude: {executable: 'claude', listArgs: ['mcp', 'list'], addArgs: (target) => ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'manumcp', '--', target.command, ...target.args], removeArgs: ['mcp', 'remove', 'manumcp', '--scope', 'user']},
    gemini: {executable: 'gemini', listArgs: ['mcp', 'list'], addArgs: (target) => ['mcp', 'add', 'manumcp', target.command, ...target.args, '--scope', 'user'], removeArgs: ['mcp', 'remove', 'manumcp', '--scope', 'user']},
};

async function configureCli(name, target, {dryRun, replace}) {
    const definition = cliDefinitions[name];
    const executable = executableOnPath(definition.executable);
    if (!executable) return {status: 'not-installed', client: name};

    if (!replace && !dryRun) {
        const listed = captureCommand(executable, definition.listArgs);
        if (listed.ok && /(^|[^\w])manumcp([^\w]|$)/iu.test(listed.output)) {
            return {status: 'already-present', client: name, detail: 'ya existe; no se sobrescribió (usa --replace para actualizarlo)'};
        }
    }
    if (replace && !dryRun) {
        await runCommand(executable, definition.removeArgs, {timeoutMs: 30_000}).catch(() => undefined);
    }
    const exitCode = await runCommand(executable, definition.addArgs(target), {dryRun});
    return exitCode === 0
        ? {status: dryRun ? 'would-configure' : 'configured', client: name}
        : {status: 'failed', client: name, exitCode};
}

async function openExternal(url, dryRun) {
    if (dryRun) {
        console.log(`DRY-RUN  abriría ${url}`);
        return;
    }
    let command;
    let args;
    if (process.platform === 'win32') {
        command = 'cmd.exe';
        args = ['/c', 'start', '', url];
    }
    else if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
    }
    else {
        command = 'xdg-open';
        args = [url];
    }
    await runCommand(command, args, {timeoutMs: 15_000}).catch((error) => {
        console.warn(`No se pudo abrir el navegador automáticamente: ${error.message}`);
    });
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }
    const requested = options.clients.length > 0 ? options.clients : ['auto'];
    const invalid = requested.filter((client) => !['auto', 'none', ...supportedClients].includes(client));
    if (invalid.length > 0) throw new Error(`Cliente no compatible: ${invalid.join(', ')}`);
    const target = configuredStdioTarget();
    console.log(`ManuMCP stdio: ${target.description}`);
    console.log(`Comando: ${displayCommand(target.command, target.args)}`);

    const selected = requested.includes('none')
        ? []
        : requested.includes('auto')
            ? supportedClients
            : [...new Set(requested)];
    const results = [];
    for (const client of selected) {
        if (client === 'cursor') {
            const executable = executableOnPath('cursor');
            const configExists = fs.existsSync(cursorConfigPath());
            if (!executable && !configExists && requested.includes('auto')) {
                results.push({status: 'not-installed', client});
                continue;
            }
            results.push({client, ...(await mergeCursorConfig(target, options))});
            continue;
        }
        results.push(await configureCli(client, target, options));
    }

    if (options.openChatGpt) {
        await openExternal(chatGptSettingsUrl, options.dryRun);
        console.log(`ChatGPT web: abre ${chatGptSettingsUrl}`);
        console.log('ChatGPT web requiere que el propietario inicie sesión y autorice la app/túnel en Developer mode; este script no recoge credenciales ni puede saltar esa autorización.');
        console.log('Después de crear o actualizar la app: Scan Tools/Actualizar, selecciona ManuMCP y prueba get_device_health y list_storage_volumes en un chat.');
    }

    console.log(JSON.stringify({projectRoot, chatGptSettingsUrl, results}, null, 2));
    if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
}

main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
});
