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
        'pc:/ (raíz configurada del PC)',
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
        'list_workspace',
        'read_workspace_file',
        'search_workspace',
        'create_workspace_directory',
        'create_workspace_file',
        'replace_workspace_text',
        'apply_workspace_patch',
    ]);

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

    const directoryProposalReply = await callTool(port, accessToken, 6, 'create_workspace_directory', { root: 'desktop', path: 'desktop:/site' });
    const directoryProposal = JSON.parse(toolText(directoryProposalReply));
    assert.equal(directoryProposal.applied, false);
    const directoryApplied = await callTool(port, accessToken, 7, 'create_workspace_directory', {
        root: 'desktop',
        path: 'desktop:/site',
        confirmationToken: directoryProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(directoryApplied)).applied, true);

    const downloadsProposalReply = await callTool(port, accessToken, 8, 'create_workspace_directory', {
        root: 'downloads',
        path: 'downloads:/download-site',
    });
    const downloadsProposal = JSON.parse(toolText(downloadsProposalReply));
    const downloadsApplied = await callTool(port, accessToken, 9, 'create_workspace_directory', {
        root: 'downloads',
        path: 'downloads:/download-site',
        confirmationToken: downloadsProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(downloadsApplied)).applied, true);
    const naturalDownloadsProposalReply = await callTool(port, accessToken, 10, 'create_workspace_directory', {
        path: 'Downloads/natural-download-site',
    });
    const naturalDownloadsProposal = JSON.parse(toolText(naturalDownloadsProposalReply));
    const naturalDownloadsApplied = await callTool(port, accessToken, 11, 'create_workspace_directory', {
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

    const pcProposalReply = await callTool(port, accessToken, 12, 'create_workspace_directory', {
        root: 'pc',
        path: 'pc:/profile-site',
    });
    const pcProposal = JSON.parse(toolText(pcProposalReply));
    const pcApplied = await callTool(port, accessToken, 13, 'create_workspace_directory', {
        root: 'pc',
        path: 'pc:/profile-site',
        confirmationToken: pcProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(pcApplied)).applied, true);
    await fs.access(path.join(pcDirectory, 'profile-site'));

    const absolutePcProposalReply = await callTool(port, accessToken, 14, 'create_workspace_directory', {
        path: path.join(pcDirectory, 'absolute-site'),
    });
    const absolutePcProposal = JSON.parse(toolText(absolutePcProposalReply));
    const absolutePcApplied = await callTool(port, accessToken, 15, 'create_workspace_directory', {
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

    const proposal = await callTool(port, accessToken, 16, 'create_workspace_file', {
        path: 'site/index.html',
        content: '<h1>ManuMCP</h1>\n<p>local file</p>\n',
    });
    const proposalData = JSON.parse(toolText(proposal));
    assert.equal(proposalData.applied, false);
    assert.equal(proposalData.requiresConfirmation, true);
    await assert.rejects(fs.access(path.join(workspaceDirectory, 'site', 'index.html')), { code: 'ENOENT' });

    const applied = await callTool(port, accessToken, 17, 'create_workspace_file', {
        path: 'site/index.html',
        content: '<h1>ManuMCP</h1>\n<p>local file</p>\n',
        confirmationToken: proposalData.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(applied)).applied, true);
    assert.equal(await fs.readFile(path.join(workspaceDirectory, 'site', 'index.html'), 'utf8'), '<h1>ManuMCP</h1>\n<p>local file</p>\n');

    const read = await callTool(port, accessToken, 18, 'read_workspace_file', { path: 'site/index.html' });
    const readData = JSON.parse(toolText(read));
    assert.equal(readData.text, '<h1>ManuMCP</h1>\n<p>local file</p>');
    assert.equal(readData.path, 'workspace:/site/index.html');
    const search = await callTool(port, accessToken, 19, 'search_workspace', { query: 'ManuMCP' });
    assert.equal(JSON.parse(toolText(search)).matches[0].path, 'workspace:/site/index.html');

    const traversal = await callTool(port, accessToken, 20, 'read_workspace_file', { path: '../outside.txt' });
    assert.equal(traversal.result.isError, true);
    assert.match(toolText(traversal), /PATH_TRAVERSAL/u);
    const secretProposal = await callTool(port, accessToken, 21, 'create_workspace_file', {
        path: 'secret.txt',
        content: 'api_key = "this-is-not-a-real-key-but-is-long"\n',
    });
    assert.equal(secretProposal.result.isError, true);
    assert.match(toolText(secretProposal), /SECRET_CONTENT_BLOCKED/u);

    const secondProposal = await callTool(port, accessToken, 22, 'create_workspace_file', {
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
    assert.equal(JSON.parse(toolText(await callTool(port, accessToken, 23, 'create_workspace_file', secondApplyArgs))).applied, true);
    const replay = await callTool(port, accessToken, 24, 'create_workspace_file', secondApplyArgs);
    assert.equal(replay.result.isError, true);
    assert.match(toolText(replay), /CONFIRMATION_INVALID/u);
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
