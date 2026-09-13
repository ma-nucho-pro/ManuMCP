import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

async function waitForStartup(child) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const onData = (chunk) => {
            buffer += chunk.toString();
            const match = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/u.exec(buffer);
            if (match !== null) {
                child.stdout.off('data', onData);
                resolve(Number(match[1]));
            }
        };
        child.stdout.on('data', onData);
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`ManuMCP terminó antes de iniciar (${code}). ${buffer}`)));
    });
}

function waitForLine(stream, pattern) {
    return new Promise((resolve, reject) => {
        let buffer = '';
        const onData = (chunk) => {
            buffer += chunk.toString();
            const match = pattern.exec(buffer);
            if (match !== null) {
                stream.off('data', onData);
                resolve(match);
            }
        };
        stream.on('data', onData);
        stream.once('error', reject);
    });
}

async function callMcp(port, accessToken, id, method, params = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${accessToken}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
}

async function callTool(port, accessToken, id, name, argumentsValue = {}) {
    return callMcp(port, accessToken, id, 'tools/call', { name, arguments: argumentsValue });
}

function toolText(reply) {
    return reply.result?.content?.[0]?.text ?? '';
}

async function createTestDirectory(prefix) {
    return fs.mkdtemp(path.join(os.homedir(), `ManuMCP-test-${prefix}-`));
}

test('ManuMCP serves authenticated MCP over loopback and keeps file access inside the authorized roots', async (t) => {
    const directory = await createTestDirectory('http');
    const workspaceDirectory = path.join(directory, 'Desktop');
    const downloadsDirectory = path.join(directory, 'downloads');
    const pcDirectory = path.join(directory, 'pc');
    const accessToken = 'integration-token-for-manumcp-1234567890';
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'app', 'server.js')], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MANUMCP_WORKSPACE: workspaceDirectory,
            MANUMCP_DOWNLOADS: downloadsDirectory,
            MANUMCP_PC_ROOT: pcDirectory,
            MANUMCP_LOCAL_TOKEN: accessToken,
            MANUMCP_CONFIRMATION_KEY: 'integration-confirmation-key',
            MANUMCP_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        await fs.rm(directory, { recursive: true, force: true });
    });

    const port = await waitForStartup(child);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    const healthData = await health.json();
    assert.equal(healthData.workspace, 'workspace:/');
    assert.deepEqual(healthData.authorizedRoots, [
        'workspace:/ (Escritorio)',
        'downloads:/ (Descargas)',
        'pc:/ (raíz completa del equipo)',
    ]);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET' });
    assert.equal(unauthorized.status, 401);

    const initialized = await callMcp(port, accessToken, 1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'manumcp-integration-test', version: '1.0.0' },
    });
    assert.equal(initialized.result.serverInfo.name, 'ManuMCP');
    const tools = await callMcp(port, accessToken, 2, 'tools/list');
    assert.deepEqual(tools.result.tools.map((tool) => tool.name), [
        'get_device_health',
        'list_storage_volumes',
        'get_storage_volumes',
        'list_workspace',
        'read_workspace_file',
        'search_workspace',
        'create_workspace_directory',
        'create_workspace_file',
        'replace_workspace_text',
        'apply_workspace_patch',
        'run_command',
        'launch_application',
        'open_item',
        'open_url',
        'list_processes',
        'terminate_process',
        'list_windows',
        'focus_window',
        'close_window',
        'get_screen_info',
        'capture_screen',
        'get_cursor_position',
        'control_mouse',
        'type_text',
        'press_hotkey',
    ]);
    const openUrlTool = tools.result.tools.find((tool) => tool.name === 'open_url');
    assert.deepEqual(openUrlTool.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    });

    const desktopAliasReply = await callTool(port, accessToken, 3, 'list_workspace', { root: 'desktop', path: 'desktop:/' });
    assert.equal(desktopAliasReply.result.isError, undefined);
    assert.equal(JSON.parse(toolText(desktopAliasReply)).root, 'workspace:/');

    const downloadsReply = await callTool(port, accessToken, 4, 'list_workspace', { root: 'descargas', path: 'descargas:/' });
    assert.equal(downloadsReply.result.isError, undefined);
    assert.equal(JSON.parse(toolText(downloadsReply)).root, 'downloads:/');
    const downloadsBackslashReply = await callTool(port, accessToken, 29, 'list_workspace', { path: 'downloads:\\' });
    assert.equal(downloadsBackslashReply.result.isError, undefined);
    assert.equal(JSON.parse(toolText(downloadsBackslashReply)).root, 'downloads:/');

    const pcReply = await callTool(port, accessToken, 5, 'list_workspace', { root: 'computer', path: 'computer:/' });
    assert.equal(pcReply.result.isError, undefined);
    assert.equal(JSON.parse(toolText(pcReply)).root, 'pc:/');
    const volumesReply = await callTool(port, accessToken, 6, 'list_storage_volumes');
    assert.equal(volumesReply.result.isError, undefined);
    assert.ok(JSON.parse(toolText(volumesReply)).volumes.some((volume) => volume.alias === 'pc'));
    const healthReply = await callTool(port, accessToken, 7, 'get_device_health');
    assert.equal(healthReply.result.isError, undefined);
    assert.ok(JSON.parse(toolText(healthReply)).volumes.some((volume) => volume.alias === 'pc'));

    for (const [id, invalidUrl] of [
        [80, 'file:///C:/Windows/System32'],
        [81, 'https://user:password@example.com'],
        [82, 'https://@example.com'],
        [83, ' https://example.com'],
        [84, 'https://example.com '],
        [85, 'https://example.com/a b'],
    ]) {
        const invalidUrlReply = await callTool(port, accessToken, id, 'open_url', { url: invalidUrl });
        assert.equal(invalidUrlReply.result.isError, true);
        assert.match(toolText(invalidUrlReply), /HTTP\/HTTPS|válida|valid|espacios|usuario|contraseña/u);
    }

    for (const [id, name, argumentsValue] of [
        [40, 'run_command', { command: 'Write-Output preview-only', shell: 'powershell', cwd: 'workspace:/', timeoutMs: 1_000 }],
        [41, 'launch_application', { executable: 'notepad.exe', cwd: 'workspace:/' }],
        [42, 'open_item', { path: 'pc:/' }],
        [43, 'terminate_process', { pid: 12_345, force: false }],
        [44, 'focus_window', { handle: 12_345 }],
        [45, 'close_window', { handle: 12_345 }],
        [46, 'control_mouse', { action: 'move', x: 10, y: 20 }],
        [47, 'type_text', { text: 'preview-only' }],
        [48, 'press_hotkey', { keys: ['CTRL', 'L'] }],
        [49, 'open_url', { url: 'https://example.com' }],
    ]) {
        const previewReply = await callTool(port, accessToken, id, name, argumentsValue);
        assert.equal(previewReply.result.isError, undefined, `${name} preview failed: ${toolText(previewReply)}`);
        const preview = JSON.parse(toolText(previewReply));
        assert.equal(preview.applied, false);
        assert.equal(preview.requiresConfirmation, true);
        assert.equal(typeof preview.confirmationToken, 'string');
    }

    const browserProposal = JSON.parse(toolText(await callTool(port, accessToken, 86, 'open_url', { url: 'https://example.com' })));
    const tamperedBrowserConfirmation = await callTool(port, accessToken, 87, 'open_url', {
        url: 'https://example.org',
        confirmationToken: browserProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(tamperedBrowserConfirmation.result.isError, true);
    assert.match(toolText(tamperedBrowserConfirmation), /CONFIRMATION_INVALID|confirmación|confirmation/u);

    const directoryProposalReply = await callTool(port, accessToken, 7, 'create_workspace_directory', { root: 'desktop', path: 'desktop:/site' });
    const directoryProposal = JSON.parse(toolText(directoryProposalReply));
    assert.equal(directoryProposal.applied, false);
    const directoryApplied = await callTool(port, accessToken, 8, 'create_workspace_directory', {
        root: 'desktop',
        path: 'desktop:/site',
        confirmationToken: directoryProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(directoryApplied)).applied, true);

    const downloadsProposalReply = await callTool(port, accessToken, 9, 'create_workspace_directory', {
        root: 'downloads',
        path: 'downloads:/download-site',
    });
    const downloadsProposal = JSON.parse(toolText(downloadsProposalReply));
    const downloadsApplied = await callTool(port, accessToken, 10, 'create_workspace_directory', {
        root: 'downloads',
        path: 'downloads:/download-site',
        confirmationToken: downloadsProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(downloadsApplied)).applied, true);
    const naturalDownloadsProposalReply = await callTool(port, accessToken, 11, 'create_workspace_directory', {
        path: 'Downloads/natural-download-site',
    });
    const naturalDownloadsProposal = JSON.parse(toolText(naturalDownloadsProposalReply));
    const naturalDownloadsApplied = await callTool(port, accessToken, 12, 'create_workspace_directory', {
        path: 'Downloads/natural-download-site',
        confirmationToken: naturalDownloadsProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(naturalDownloadsApplied)).applied, true);
    await fs.access(path.join(downloadsDirectory, 'download-site'));
    await fs.access(path.join(downloadsDirectory, 'natural-download-site'));

    await fs.mkdir(path.join(pcDirectory, 'Documents'), { recursive: true });
    const naturalPcReply = await callTool(port, accessToken, 27, 'list_workspace', {
        path: 'Documents',
        maxDepth: 1,
        maxEntries: 10,
    });
    assert.equal(naturalPcReply.result.isError, undefined);
    assert.equal(JSON.parse(toolText(naturalPcReply)).root, 'pc:/Documents');

    const pcProposalReply = await callTool(port, accessToken, 13, 'create_workspace_directory', {
        root: 'pc',
        path: 'pc:/profile-site',
    });
    const pcProposal = JSON.parse(toolText(pcProposalReply));
    const pcApplied = await callTool(port, accessToken, 14, 'create_workspace_directory', {
        root: 'pc',
        path: 'pc:/profile-site',
        confirmationToken: pcProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(pcApplied)).applied, true);
    await fs.access(path.join(pcDirectory, 'profile-site'));

    const absolutePcProposalReply = await callTool(port, accessToken, 15, 'create_workspace_directory', {
        path: path.join(pcDirectory, 'absolute-site'),
    });
    const absolutePcProposal = JSON.parse(toolText(absolutePcProposalReply));
    const absolutePcApplied = await callTool(port, accessToken, 16, 'create_workspace_directory', {
        path: path.join(pcDirectory, 'absolute-site'),
        confirmationToken: absolutePcProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(absolutePcApplied)).applied, true);
    await fs.access(path.join(pcDirectory, 'absolute-site'));

    await fs.mkdir(path.join(pcDirectory, 'AppData'), { recursive: true });
    await fs.writeFile(path.join(pcDirectory, 'AppData', 'blocked.txt'), 'protected profile data\n');
    const protectedReply = await callTool(port, accessToken, 25, 'read_workspace_file', {
        path: 'pc:/AppData/blocked.txt',
    });
    assert.equal(protectedReply.result.isError, true);
    assert.match(toolText(protectedReply), /PATH_DENIED/u);
    if (process.platform === 'win32') {
        const protectedCaseReply = await callTool(port, accessToken, 31, 'read_workspace_file', {
            path: 'pc:/appdata/blocked.txt',
        });
        assert.equal(protectedCaseReply.result.isError, true);
        assert.match(toolText(protectedCaseReply), /PATH_DENIED/u);
    }
    const protectedListingReply = await callTool(port, accessToken, 26, 'list_workspace', {
        root: 'pc',
        path: 'pc:/',
        maxDepth: 1,
        maxEntries: 100,
    });
    const protectedListing = JSON.parse(toolText(protectedListingReply));
    assert.equal(protectedListing.entries.some((entry) => entry.path === 'pc:/AppData'), false);
    let protectedRequestId = 32;
    for (const protectedDirectory of ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData']) {
        await fs.mkdir(path.join(pcDirectory, protectedDirectory), { recursive: true });
        const protectedDirectoryReply = await callTool(port, accessToken, protectedRequestId++, 'list_workspace', {
            root: 'pc',
            path: `pc:/${protectedDirectory}`,
        });
        assert.equal(protectedDirectoryReply.result.isError, true);
        assert.match(toolText(protectedDirectoryReply), /PATH_DENIED/u);
    }

    const outsideProfileReply = await callTool(port, accessToken, 28, 'read_workspace_file', {
        path: path.join(directory, 'another-user', 'outside.txt'),
    });
    assert.equal(outsideProfileReply.result.isError, true);
    assert.match(toolText(outsideProfileReply), /PATH_OUTSIDE_ROOT/u);
    const absoluteTraversalReply = await callTool(port, accessToken, 30, 'read_workspace_file', {
        path: pcDirectory + '\\..\\outside.txt',
    });
    assert.equal(absoluteTraversalReply.result.isError, true);
    assert.match(toolText(absoluteTraversalReply), /PATH_TRAVERSAL/u);

    const proposal = await callTool(port, accessToken, 17, 'create_workspace_file', {
        path: 'site/index.html',
        content: '<h1>ManuMCP</h1>\n<p>local file</p>\n',
    });
    const proposalData = JSON.parse(toolText(proposal));
    assert.equal(proposalData.applied, false);
    assert.equal(proposalData.requiresConfirmation, true);
    await assert.rejects(fs.access(path.join(workspaceDirectory, 'site', 'index.html')), { code: 'ENOENT' });

    const applied = await callTool(port, accessToken, 18, 'create_workspace_file', {
        path: 'site/index.html',
        content: '<h1>ManuMCP</h1>\n<p>local file</p>\n',
        confirmationToken: proposalData.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(applied)).applied, true);
    assert.equal(await fs.readFile(path.join(workspaceDirectory, 'site', 'index.html'), 'utf8'), '<h1>ManuMCP</h1>\n<p>local file</p>\n');

    const read = await callTool(port, accessToken, 19, 'read_workspace_file', { path: 'site/index.html' });
    const readData = JSON.parse(toolText(read));
    assert.equal(readData.text, '<h1>ManuMCP</h1>\n<p>local file</p>');
    assert.equal(readData.path, 'workspace:/site/index.html');
    const search = await callTool(port, accessToken, 20, 'search_workspace', { query: 'ManuMCP' });
    assert.equal(JSON.parse(toolText(search)).matches[0].path, 'workspace:/site/index.html');

    const traversal = await callTool(port, accessToken, 21, 'read_workspace_file', { path: '../outside.txt' });
    assert.equal(traversal.result.isError, true);
    assert.match(toolText(traversal), /PATH_TRAVERSAL/u);
    const secretProposal = await callTool(port, accessToken, 22, 'create_workspace_file', {
        path: 'secret.txt',
        content: 'api_key = "this-is-not-a-real-key-but-is-long"\n',
    });
    assert.equal(secretProposal.result.isError, true);
    assert.match(toolText(secretProposal), /SECRET_CONTENT_BLOCKED/u);

    const secondProposal = await callTool(port, accessToken, 23, 'create_workspace_file', {
        path: 'one-time.txt',
        content: 'only once',
    });
    const secondData = JSON.parse(toolText(secondProposal));
    const secondApplyArgs = {
        path: 'one-time.txt',
        content: 'only once',
        confirmationToken: secondData.confirmationToken,
        confirmed: true,
    };
    assert.equal(JSON.parse(toolText(await callTool(port, accessToken, 24, 'create_workspace_file', secondApplyArgs))).applied, true);
    const replay = await callTool(port, accessToken, 25, 'create_workspace_file', secondApplyArgs);
    assert.equal(replay.result.isError, true);
    assert.match(toolText(replay), /CONFIRMATION_INVALID/u);
});

test('Windows control tools reach the native desktop only through confirmed actions', {
    skip: process.platform !== 'win32'
        ? 'Windows-only native control test.'
        : process.env.GITHUB_ACTIONS === 'true'
            ? 'Hosted GitHub Windows runners do not guarantee an interactive desktop session.'
            : false,
}, async (t) => {
    const directory = await createTestDirectory('windows-control');
    const workspaceDirectory = path.join(directory, 'Desktop');
    const downloadsDirectory = path.join(directory, 'downloads');
    const pcDirectory = path.join(directory, 'pc');
    const accessToken = 'integration-token-for-windows-control-1234567890';
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'app', 'server.js')], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MANUMCP_WORKSPACE: workspaceDirectory,
            MANUMCP_DOWNLOADS: downloadsDirectory,
            MANUMCP_PC_ROOT: pcDirectory,
            MANUMCP_LOCAL_TOKEN: accessToken,
            MANUMCP_CONFIRMATION_KEY: 'windows-control-confirmation-key',
            MANUMCP_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        await fs.rm(directory, { recursive: true, force: true });
    });

    const port = await waitForStartup(child);
    const processes = JSON.parse(toolText(await callTool(port, accessToken, 50, 'list_processes', { filter: 'node', maxEntries: 10 })));
    assert.ok(Array.isArray(processes.processes));
    const windows = JSON.parse(toolText(await callTool(port, accessToken, 51, 'list_windows', {})));
    assert.ok(Array.isArray(windows.windows));
    const screens = JSON.parse(toolText(await callTool(port, accessToken, 52, 'get_screen_info', {})));
    assert.ok(Array.isArray(screens.screens));
    assert.ok(screens.screens.length > 0);
    const cursor = JSON.parse(toolText(await callTool(port, accessToken, 53, 'get_cursor_position', {})));
    assert.equal(Number.isInteger(cursor.x), true);
    assert.equal(Number.isInteger(cursor.y), true);

    const capture = await callTool(port, accessToken, 54, 'capture_screen', { screenIndex: 0 });
    const image = capture.result.content.find((item) => item.type === 'image');
    assert.equal(image.mimeType, 'image/png');
    assert.match(image.data, /^iVBOR/u);

    const commandPreview = JSON.parse(toolText(await callTool(port, accessToken, 55, 'run_command', {
        command: 'Write-Output ManuMCP_WINDOWS_CONTROL_TEST',
        shell: 'powershell',
        cwd: 'pc:/',
        timeoutMs: 5_000,
    })));
    assert.equal(commandPreview.applied, false);
    const commandApplied = JSON.parse(toolText(await callTool(port, accessToken, 56, 'run_command', {
        command: 'Write-Output ManuMCP_WINDOWS_CONTROL_TEST',
        shell: 'powershell',
        cwd: 'pc:/',
        timeoutMs: 5_000,
        confirmationToken: commandPreview.confirmationToken,
        confirmed: true,
    })));
    assert.equal(commandApplied.exitCode, 0);
    assert.match(commandApplied.stdout, /ManuMCP_WINDOWS_CONTROL_TEST/u);

    const launchPreview = JSON.parse(toolText(await callTool(port, accessToken, 57, 'launch_application', {
        executable: 'cmd.exe',
        arguments: ['/d', '/c', 'exit', '0'],
        cwd: 'pc:/',
    })));
    assert.equal(launchPreview.applied, false);
    const launchApplied = JSON.parse(toolText(await callTool(port, accessToken, 58, 'launch_application', {
        executable: 'cmd.exe',
        arguments: ['/d', '/c', 'exit', '0'],
        cwd: 'pc:/',
        confirmationToken: launchPreview.confirmationToken,
        confirmed: true,
    })));
    assert.equal(launchApplied.ok, true);

    const mousePreview = JSON.parse(toolText(await callTool(port, accessToken, 59, 'control_mouse', {
        action: 'move',
        x: cursor.x,
        y: cursor.y,
    })));
    assert.equal(mousePreview.applied, false);
    const typePreview = JSON.parse(toolText(await callTool(port, accessToken, 60, 'type_text', { text: 'native preview only' })));
    assert.equal(typePreview.applied, false);
    const hotkeyPreview = JSON.parse(toolText(await callTool(port, accessToken, 61, 'press_hotkey', { keys: ['CTRL', 'L'] })));
    assert.equal(hotkeyPreview.applied, false);
    const activeWindow = windows.windows.find((window) => window.active);
    if (activeWindow !== undefined) {
        const harmlessHotkeyPreview = JSON.parse(toolText(await callTool(port, accessToken, 62, 'press_hotkey', { keys: ['SHIFT'] })));
        const harmlessHotkeyApplied = JSON.parse(toolText(await callTool(port, accessToken, 63, 'press_hotkey', {
            keys: ['SHIFT'],
            confirmationToken: harmlessHotkeyPreview.confirmationToken,
            confirmed: true,
        })));
        assert.equal(harmlessHotkeyApplied.ok, true);
        assert.deepEqual(harmlessHotkeyApplied.keys, [16]);
    }
});

test('POSIX control tools run commands and report the configured computer volume', { skip: process.platform === 'win32' ? 'POSIX-only control test.' : false }, async (t) => {
    const directory = await createTestDirectory('posix-control');
    const workspaceDirectory = path.join(directory, 'Desktop');
    const downloadsDirectory = path.join(directory, 'Downloads');
    const pcDirectory = path.join(directory, 'computer');
    const accessToken = 'integration-token-for-posix-control-1234567890';
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'app', 'server.js')], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MANUMCP_WORKSPACE: workspaceDirectory,
            MANUMCP_DOWNLOADS: downloadsDirectory,
            MANUMCP_PC_ROOT: pcDirectory,
            MANUMCP_LOCAL_TOKEN: accessToken,
            MANUMCP_CONFIRMATION_KEY: 'posix-control-confirmation-key',
            MANUMCP_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        await fs.rm(directory, { recursive: true, force: true });
    });

    const port = await waitForStartup(child);
    const volumes = JSON.parse(toolText(await callTool(port, accessToken, 70, 'list_storage_volumes')));
    assert.equal(volumes.volumes[0].alias, 'pc');
    assert.equal(volumes.volumes[0].path, pcDirectory);
    assert.equal(volumes.volumes[0].accessPath, 'pc:/');

    const commandArguments = {
        command: 'printf MANUMCP_POSIX_CONTROL_TEST',
        shell: 'sh',
        cwd: 'pc:/',
        timeoutMs: 5_000,
    };
    const commandPreview = JSON.parse(toolText(await callTool(port, accessToken, 71, 'run_command', commandArguments)));
    assert.equal(commandPreview.applied, false);
    const commandApplied = JSON.parse(toolText(await callTool(port, accessToken, 72, 'run_command', {
        ...commandArguments,
        confirmationToken: commandPreview.confirmationToken,
        confirmed: true,
    })));
    assert.equal(commandApplied.exitCode, 0);
    assert.equal(commandApplied.stdout, 'MANUMCP_POSIX_CONTROL_TEST');
    assert.equal(commandApplied.cwd, pcDirectory);

    const processes = JSON.parse(toolText(await callTool(port, accessToken, 73, 'list_processes', { filter: 'node', maxEntries: 10 })));
    assert.ok(Array.isArray(processes.processes));
});

test('ManuMCP also speaks MCP over stdio for a private tunnel client', async (t) => {
    const directory = await createTestDirectory('stdio');
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'app', 'server.js'), '--stdio'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MANUMCP_WORKSPACE: directory,
            MANUMCP_DOWNLOADS: path.join(directory, 'downloads'),
            MANUMCP_PC_ROOT: path.join(directory, 'pc'),
            MANUMCP_CONFIRMATION_KEY: 'stdio-confirmation-key',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(async () => {
        if (child.exitCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        await fs.rm(directory, { recursive: true, force: true });
    });
    await waitForLine(child.stderr, /ManuMCP stdio listo/u);
    child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1.0.0' } },
    })}\n`);
    const initialize = JSON.parse((await waitForLine(child.stdout, /^(\{.*\})$/mu))[1]);
    assert.equal(initialize.result.serverInfo.name, 'ManuMCP');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_device_health', arguments: {} } })}\n`);
    const health = JSON.parse((await waitForLine(child.stdout, /^(\{.*\})$/mu))[1]);
    assert.match(health.result.content[0].text, /"transport": "stdio"/u);
});
