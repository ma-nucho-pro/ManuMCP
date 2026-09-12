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

test('ManuMCP serves authenticated MCP over loopback and keeps file access inside one workspace', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manumcp-http-'));
    const accessToken = 'integration-token-for-manumcp-1234567890';
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'app', 'server.js')], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MANUMCP_WORKSPACE: directory,
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
    assert.equal((await health.json()).workspace, 'workspace:/');
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

    const directoryProposalReply = await callTool(port, accessToken, 3, 'create_workspace_directory', { path: 'site' });
    const directoryProposal = JSON.parse(toolText(directoryProposalReply));
    assert.equal(directoryProposal.applied, false);
    const directoryApplied = await callTool(port, accessToken, 4, 'create_workspace_directory', {
        path: 'site',
        confirmationToken: directoryProposal.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(directoryApplied)).applied, true);

    const proposal = await callTool(port, accessToken, 5, 'create_workspace_file', {
        path: 'site/index.html',
        content: '<h1>ManuMCP</h1>\n<p>local file</p>\n',
    });
    const proposalData = JSON.parse(toolText(proposal));
    assert.equal(proposalData.applied, false);
    assert.equal(proposalData.requiresConfirmation, true);
    await assert.rejects(fs.access(path.join(directory, 'site', 'index.html')), { code: 'ENOENT' });

    const applied = await callTool(port, accessToken, 6, 'create_workspace_file', {
        path: 'site/index.html',
        content: '<h1>ManuMCP</h1>\n<p>local file</p>\n',
        confirmationToken: proposalData.confirmationToken,
        confirmed: true,
    });
    assert.equal(JSON.parse(toolText(applied)).applied, true);
    assert.equal(await fs.readFile(path.join(directory, 'site', 'index.html'), 'utf8'), '<h1>ManuMCP</h1>\n<p>local file</p>\n');

    const read = await callTool(port, accessToken, 7, 'read_workspace_file', { path: 'site/index.html' });
    const readData = JSON.parse(toolText(read));
    assert.equal(readData.text, '<h1>ManuMCP</h1>\n<p>local file</p>');
    assert.equal(readData.path, 'workspace:/site/index.html');
    const search = await callTool(port, accessToken, 8, 'search_workspace', { query: 'ManuMCP' });
    assert.equal(JSON.parse(toolText(search)).matches[0].path, 'workspace:/site/index.html');

    const traversal = await callTool(port, accessToken, 9, 'read_workspace_file', { path: '../outside.txt' });
    assert.equal(traversal.result.isError, true);
    assert.match(toolText(traversal), /PATH_TRAVERSAL/u);
    const secretProposal = await callTool(port, accessToken, 10, 'create_workspace_file', {
        path: 'secret.txt',
        content: 'api_key = "this-is-not-a-real-key-but-is-long"\n',
    });
    assert.equal(secretProposal.result.isError, true);
    assert.match(toolText(secretProposal), /SECRET_CONTENT_BLOCKED/u);

    const secondProposal = await callTool(port, accessToken, 11, 'create_workspace_file', {
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
    assert.equal(JSON.parse(toolText(await callTool(port, accessToken, 12, 'create_workspace_file', secondApplyArgs))).applied, true);
    const replay = await callTool(port, accessToken, 13, 'create_workspace_file', secondApplyArgs);
    assert.equal(replay.result.isError, true);
    assert.match(toolText(replay), /CONFIRMATION_INVALID/u);
});

test('ManuMCP also speaks MCP over stdio for a private tunnel client', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manumcp-stdio-'));
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'app', 'server.js'), '--stdio'], {
        cwd: process.cwd(),
        env: { ...process.env, MANUMCP_WORKSPACE: directory, MANUMCP_CONFIRMATION_KEY: 'stdio-confirmation-key' },
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
