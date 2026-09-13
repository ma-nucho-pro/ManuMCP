import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const scriptPath = path.join(process.cwd(), 'scripts', 'configure-clients.mjs');

function runConfigurator(args, environment = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd: process.cwd(),
            env: {...process.env, ...environment},
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({code, signal, stdout, stderr}));
    });
}

test('client configurator exposes a safe dry-run and stdio target', async () => {
    const result = await runConfigurator(['--client', 'none', '--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ManuMCP stdio:/u);
    assert.match(result.stdout, /"results": \[\]/u);
});

test('client configurator preserves Cursor servers and writes ManuMCP entry', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ManuMCP-configurator-'));
    const configPath = path.join(directory, 'mcp.json');
    await fs.writeFile(configPath, `${JSON.stringify({
        $schema: 'https://example.invalid/mcp.schema.json',
        mcpServers: {other: {command: 'other-client'}},
    }, null, 2)}\n`);
    t.after(() => fs.rm(directory, {recursive: true, force: true}));

    const result = await runConfigurator(['--client', 'cursor', '--replace'], {
        MANUMCP_CURSOR_CONFIG: configPath,
    });
    assert.equal(result.code, 0, result.stderr);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(config.mcpServers.other, {command: 'other-client'});
    assert.equal(config.mcpServers.manumcp.type, 'stdio');
    assert.ok(typeof config.mcpServers.manumcp.command === 'string');
    assert.ok(Array.isArray(config.mcpServers.manumcp.args));
    const files = await fs.readdir(directory);
    assert.equal(files.some((file) => file.startsWith('mcp.json.bak-')), true);
});
