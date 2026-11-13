/**
 * 在真实 Edge 里打开页面，等页面自己的异步流程跑完后，求值一段任意表达式。
 * node 24 自带全局 WebSocket，无需依赖。
 *
 * 用法: node scripts/cdp-eval.mjs <url> <expression> [waitMs]
 *   expression 会被包进 JSON.stringify(...) 求值并打印结果。
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9334;

const url = process.argv[2];
const expression = process.argv[3];
const waitMs = Number(process.argv[4] || 12000);
if (!url || !expression) {
    console.error('usage: node cdp-eval.mjs <url> <expression> [waitMs]');
    process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'claw-eval-'));
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
        } else if (msg.method === 'Runtime.consoleAPICalled') {
            const text = (msg.params.args || [])
                .map(a => (a.value !== undefined ? a.value : a.description || a.type))
                .join(' ');
            console.log(`[console.${msg.params.type}] ${text}`);
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

    return {ws, ready, send};
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
    await send('Page.navigate', {url});
    await sleep(waitMs);

    const result = await send('Runtime.evaluate', {
        expression: `JSON.stringify(${expression})`,
        returnByValue: true,
        awaitPromise: true
    });
    if (result.exceptionDetails) {
        console.error('EVAL THREW: ' + JSON.stringify(result.exceptionDetails));
        process.exitCode = 1;
    } else {
        console.log(result.result && result.result.value);
    }
    ws.close();
} catch (error) {
    console.error('ERROR: ' + error.message);
    process.exitCode = 1;
} finally {
    cleanup();
}
