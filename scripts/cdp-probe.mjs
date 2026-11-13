/**
 * 用 CDP 在真实 Edge 里驱动页面，等待真实时间流逝。
 * node 24 自带全局 WebSocket，无需依赖。
 *
 * 用法: node scripts/cdp-probe.mjs <url> [waitMs]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;

const url = process.argv[2];
const waitMs = Number(process.argv[3] || 12000);
if (!url) {
    console.error('usage: node cdp-probe.mjs <url> [waitMs]');
    process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'claw-cdp-'));
const edge = spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank'
], {stdio: 'ignore'});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findTarget () {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const list = await res.json();
            const page = list.find(t => t.type === 'page');
            if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch {
            // 还没起来
        }
        await sleep(250);
    }
    throw new Error('CDP endpoint never appeared');
}

function connect (wsUrl) {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const events = [];

    const ready = new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', e => reject(new Error(`ws error: ${e.message || 'unknown'}`)));
    });

    ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
            const {resolve, reject} = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
        } else if (msg.method) {
            events.push(msg);
            if (msg.method === 'Runtime.consoleAPICalled') {
                const text = (msg.params.args || [])
                    .map(a => (a.value !== undefined ? a.value : a.description || a.type))
                    .join(' ');
                console.log(`[console.${msg.params.type}] ${text}`);
            }
        }
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, {resolve, reject});
        ws.send(JSON.stringify({id, method, params}));
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`CDP timeout: ${method}`));
            }
        }, 30000);
    });

    return {ws, ready, send, events};
}

const cleanup = () => {
    try {
        edge.kill();
    } catch {
        // ignore
    }
    try {
        rmSync(profile, {recursive: true, force: true});
    } catch {
        // ignore
    }
};

try {
    const wsUrl = await findTarget();
    const {ws, ready, send} = connect(wsUrl);
    await ready;

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Log.enable');

    await send('Page.navigate', {url});
    await sleep(waitMs);

    const result = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__result ?? window.__clawTestResult ?? window.__clawWorkerTest ?? null)',
        returnByValue: true,
        awaitPromise: false
    });
    console.log('RESULT: ' + (result.result && result.result.value));

    const logLines = await send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__clawLog ?? null)',
        returnByValue: true
    });
    const raw = logLines.result && logLines.result.value;
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
        for (const line of parsed) console.log('  ' + line);
    }

    ws.close();
} catch (error) {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
} finally {
    cleanup();
}
