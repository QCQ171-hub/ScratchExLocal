#!/usr/bin/env node
/**
 * run-all.mjs — 一条命令跑完全部测试。
 *
 *   1. 确认 / 启动 Rust 后端（已在跑就复用）
 *   2. cargo test --offline          （后端单元测试）
 *   3. scripts/smoke-backend.mjs     （HTTP 端到端，76 项）
 *   4. scripts/smoke-extension.cjs   （headless scratch-vm，33 项）
 *
 * 浏览器 Worker 路径需要真实 Edge，不在这里跑（见 README 的「验证」一节）。
 *
 * 用法: node scripts/run-all.mjs [--no-cargo] [--keep-backend]
 *   --no-cargo      跳过 cargo test（只想快速看 HTTP 层时）
 *   --keep-backend  跑完不关闭本次启动的后端
 */

import {spawn, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const BACKEND_EXE = path.join(BACKEND_DIR, 'target', 'release', 'claw-backend.exe');
const BASE_URL = 'http://127.0.0.1:8971';

const argv = process.argv.slice(2);
const SKIP_CARGO = argv.includes('--no-cargo');
const KEEP_BACKEND = argv.includes('--keep-backend');

const results = [];
let backendProc = null;
let startedHere = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function heading (text) {
    console.log('');
    console.log('─'.repeat(64));
    console.log(text);
    console.log('─'.repeat(64));
}

/** 跑一条命令并继承 stdio，返回是否成功。 */
function run (label, command, args, options = {}) {
    heading(label);
    const result = spawnSync(command, args, {
        stdio: 'inherit',
        cwd: options.cwd || ROOT,
        shell: false
    });
    const ok = result.status === 0;
    results.push({label, ok});
    if (result.error) console.error(`  无法执行: ${result.error.message}`);
    return ok;
}

async function backendIsUp () {
    try {
        const res = await fetch(`${BASE_URL}/api/health`, {signal: AbortSignal.timeout(1500)});
        return res.ok;
    } catch {
        return false;
    }
}

async function ensureBackend () {
    heading('准备后端');
    if (await backendIsUp()) {
        console.log(`  后端已在 ${BASE_URL} 运行，直接复用。`);
        return true;
    }
    if (!existsSync(BACKEND_EXE)) {
        console.error(`  找不到 ${BACKEND_EXE}`);
        console.error('  先构建：cd backend; cargo build --offline --release');
        return false;
    }
    console.log(`  启动 ${BACKEND_EXE} …`);
    backendProc = spawn(BACKEND_EXE, [], {cwd: BACKEND_DIR, stdio: 'ignore'});
    startedHere = true;

    for (let i = 0; i < 40; i++) {
        if (await backendIsUp()) {
            console.log('  后端已就绪。');
            return true;
        }
        await sleep(250);
    }
    console.error('  后端启动超时。');
    return false;
}

function stopBackend () {
    if (!backendProc || KEEP_BACKEND) return;
    try {
        backendProc.kill();
        console.log('  已关闭本次启动的后端。');
    } catch {
        // ignore
    }
}

try {
    if (!SKIP_CARGO) {
        run('cargo test（后端单元测试）', 'cargo', ['test', '--offline'], {cwd: BACKEND_DIR});
    }

    const up = await ensureBackend();
    if (!up) {
        results.push({label: '后端可用性', ok: false});
    } else {
        run('HTTP 端到端（smoke-backend）', process.execPath,
            [path.join(HERE, 'smoke-backend.mjs'), BASE_URL]);
        run('headless scratch-vm（smoke-extension）', process.execPath,
            [path.join(HERE, 'smoke-extension.cjs')]);
    }
} finally {
    stopBackend();
}

heading('汇总');
let failed = 0;
for (const {label, ok} of results) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!ok) failed++;
}
console.log('');
if (failed) {
    console.error(`${failed} / ${results.length} 组失败。`);
    process.exitCode = 1;
} else {
    console.log(`${results.length} / ${results.length} 组全部通过。`);
    if (startedHere && KEEP_BACKEND) console.log('后端仍在运行（--keep-backend）。');
}
