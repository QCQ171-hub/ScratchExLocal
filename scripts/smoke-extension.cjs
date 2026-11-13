/**
 * Headless end-to-end test: real scratch-vm, real extension, real HTTP backend.
 *
 * The browser build of scratch-vm loads extensions inside a Worker. In node we
 * take the same path a builtin extension takes: hand the extension object to
 * `vm.extensionManager._registerInternalExtension`, which registers it with the
 * dispatcher and asks the runtime to convert its blocks. Everything after that
 * is the real thing — real opcode table, real sequencer, real threads.
 *
 * Usage (backend must already be listening):
 *   node scripts/smoke-extension.cjs [baseUrl]
 */

'use strict';

const path = require('path');

const HARNESS = path.join(__dirname, '..', 'harness');
const EXT_PATH = path.join(__dirname, '..', 'extension', 'claw-bridge', 'index.js');
const BASE_URL = process.argv[2] || 'http://127.0.0.1:8971';

const VM = require(path.join(HARNESS, 'node_modules', 'scratch-vm'));

let passed = 0;
let failed = 0;

function check (name, fn) {
    try {
        if (fn() === false) throw new Error('returned false');
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`  FAIL ${name}: ${error.message}`);
    }
}

async function checkAsync (name, fn) {
    try {
        if ((await fn()) === false) throw new Error('returned false');
        passed++;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed++;
        console.log(`  FAIL ${name}: ${error.message}`);
    }
}

/** Give scratch-vm's internal dispatch/registration promises a chance to settle. */
const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

async function main () {
    console.log(`\n== scratch-vm headless test against ${BASE_URL} ==\n`);

    // ------------------------------------------------------------ VM bootstrap
    const vm = new VM();
    check('vm constructed', () => vm instanceof VM);
    check('runtime exposes getOpcodeFunction',
        () => typeof vm.runtime.getOpcodeFunction === 'function');

    // ---------------------------------------------------------- extension load
    const ExtensionClass = require(EXT_PATH);
    check('extension exports a constructor', () => typeof ExtensionClass === 'function');

    const extension = new ExtensionClass(vm.runtime);
    const info = extension.getInfo();
    check('extension id matches the VM\'s rules', () => /^[a-z0-9]+$/i.test(info.id));
    check('extension id is clawbridge', () => info.id === 'clawbridge');

    vm.extensionManager._registerInternalExtension(extension);
    await tick(250);

    // -------------------------------------------------- primitives got registered
    check('runtime knows the clawbridge category',
        () => vm.runtime._blockInfo.some(c => c.id === 'clawbridge'));
    check('clawbridge_echo opcode exists',
        () => typeof vm.runtime.getOpcodeFunction('clawbridge_echo') === 'function');
    check('unknown opcode stays undefined',
        () => vm.runtime.getOpcodeFunction('clawbridge_nope') === undefined);

    const declared = info.blocks.filter(b => typeof b === 'object');
    check(`all ${declared.length} declared blocks registered`, () => {
        const missing = declared
            .map(b => `clawbridge_${b.opcode}`)
            .filter(op => typeof vm.runtime.getOpcodeFunction(op) !== 'function');
        if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
        return true;
    });
    check('extension declares 4 separators',
        () => info.blocks.filter(b => b === '---').length === 4);

    // --------------------------------------------------------- direct opcode use
    const echoFn = vm.runtime.getOpcodeFunction('clawbridge_echo');
    const computeFn = vm.runtime.getOpcodeFunction('clawbridge_compute');
    const getLatencyFn = vm.runtime.getOpcodeFunction('clawbridge_getLastLatency');

    check('echo round trips unicode',
        async () => (await echoFn({ MESSAGE: 'hello 爪子' })) === 'hello 爪子');
    check('compute add', async () => (await computeFn({ OP: 'add', A: 2, B: 3 })) === 5);
    check('compute mul', async () => (await computeFn({ OP: 'mul', A: 6, B: 7 })) === 42);
    check('compute sha1', async () => (await computeFn({ OP: 'sha1', TEXT: 'abc' })) ===
        'a9993e364706816aba3e25717850c26c9cd0d89d');
    check('compute prime 97', async () => (await computeFn({ OP: 'prime', A: 97 })) === true);
    check('compute prime 91', async () => (await computeFn({ OP: 'prime', A: 91 })) === false);
    check('compute fib 10', async () => (await computeFn({ OP: 'fib', A: 10 })) === 55);
    check('compute reverse unicode',
        async () => (await computeFn({ OP: 'reverse', TEXT: '爪哇你好' })) === '好你哇爪');

    // Promise-ness: a remote block must hand scratch-vm a thenable so the thread
    // parks in STATUS_PROMISE_WAIT instead of blocking the render loop.
    check('remote block returns a thenable', () => {
        const out = echoFn({ MESSAGE: 'async?' });
        return Boolean(out) && typeof out.then === 'function';
    });
    await tick(150);

    // ------------------------------------------------------ error handling paths
    const divByZero = await computeFn({ OP: 'div', A: 1, B: 0 });
    check('division by zero yields empty result', () => divByZero === '');
    check('division by zero is recorded',
        () => /division by zero/.test(extension.lastError));

    const unknownOp = await computeFn({ OP: 'nonsense', A: 1, B: 2 });
    check('unknown op yields empty result', () => unknownOp === '');
    check('unknown op is recorded',
        () => /unknown op: nonsense/.test(extension.lastError));

    const counterAdd = vm.runtime.getOpcodeFunction('clawbridge_counterAdd');
    const counterValue = vm.runtime.getOpcodeFunction('clawbridge_counterValue');
    const beforeValue = await counterValue({});
    await counterAdd({ DELTA: 5 });
    const afterValue = await counterValue({});
    check('counter increments by delta', () => afterValue === beforeValue + 5);

    // ---------------------------------------------------- real VM thread execution
    // A green-flag hat feeding a "set variable" block whose value comes from the
    // extension. This exercises sequencer + execute.js promise handling, not just
    // our function in isolation.
    // A bare `new VM()` has no stage or sprites, so materialise one. The blocks
    // and the variable both live on this target.
    const Sprite = require(path.join(
        HARNESS, 'node_modules', 'scratch-vm', 'src', 'sprites', 'sprite.js'));
    const RenderedTarget = require(path.join(
        HARNESS, 'node_modules', 'scratch-vm', 'src', 'sprites', 'rendered-target.js'));

    const sprite = new Sprite(null, vm.runtime);
    const stage = new RenderedTarget(sprite, vm.runtime);
    stage.isStage = true;
    vm.runtime.addTarget(stage);

    const variable = stage.lookupOrCreateVariable('claw_result', 'claw_result');

    stage.blocks.createBlock({
        id: 'claw_hat',
        opcode: 'event_whenflagclicked',
        inputs: {},
        fields: {},
        next: 'claw_set',
        topLevel: true,
        parent: null,
        shadow: false
    });
    stage.blocks.createBlock({
        id: 'claw_set',
        opcode: 'data_setvariableto',
        inputs: {
            VALUE: { name: 'VALUE', block: 'claw_echo_block', shadow: 'claw_echo_block' }
        },
        fields: {
            VARIABLE: { name: 'VARIABLE', id: variable.id, value: variable.name }
        },
        next: null,
        topLevel: false,
        parent: 'claw_hat',
        shadow: false
    });
    stage.blocks.createBlock({
        id: 'claw_echo_block',
        opcode: 'clawbridge_echo',
        inputs: {
            MESSAGE: { name: 'MESSAGE', block: 'claw_msg', shadow: 'claw_msg' }
        },
        fields: {},
        next: null,
        topLevel: false,
        parent: 'claw_set',
        shadow: false
    });
    stage.blocks.createBlock({
        id: 'claw_msg',
        opcode: 'text',
        inputs: {},
        fields: { TEXT: { name: 'TEXT', value: 'from thread' } },
        next: null,
        topLevel: false,
        parent: 'claw_echo_block',
        shadow: true
    });

    // `runtime.start()` is what the GUI calls: it sets `currentStepTime` and
    // installs the 60 Hz stepping interval. Without it `currentStepTime` stays
    // null, the sequencer's work budget becomes `0.75 * null === 0`, and the
    // step loop never runs a single thread.
    vm.runtime.start();

    const pump = async (ms = 3000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (variable.value === 'from thread') return true;
            if (vm.runtime.threads.length === 0) return true;
            await tick(16);
        }
        return false;
    };

    vm.runtime.greenFlag();
    const advanced = await pump();

    check('VM thread executed the async block', () => variable.value === 'from thread');
    check('thread loop reached a terminal state', () => advanced === true);
    check('no threads left stuck',
        () => vm.runtime.threads.every(t => t.status === 0 || t.status === 4));

    vm.runtime.quit();

    // ------------------------------------------------------------ failure modes
    extension.setBaseUrl({ URL: 'http://127.0.0.1:1' });
    const deadEcho = await echoFn({ MESSAGE: 'nobody home' });
    check('unreachable backend yields empty result', () => deadEcho === '');
    check('unreachable backend is recorded',
        () => /无法连接后端/.test(extension.lastError));

    const offlineHealth = await vm.runtime.getOpcodeFunction('clawbridge_health')({});
    check('health block reports offline without throwing',
        () => offlineHealth === '离线');

    extension.setBaseUrl({ URL: BASE_URL });
    const recovered = await echoFn({ MESSAGE: 'back' });
    check('recovers once the base URL is restored', () => recovered === 'back');
    check('error state is cleared after a success', () => extension.lastError === '');
    check('latency was measured',
        () => Number.isFinite(extension.lastLatency) && extension.lastLatency >= 0);
    check('latency reporter matches the measurement',
        () => getLatencyFn({}) === extension.lastLatency);

    // ---------------------------------------------------------------- summary
    console.log(`\n== ${passed} passed, ${failed} failed ==\n`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
    console.error('harness crashed:', error);
    process.exit(1);
});
