/**
 * Claw Bridge — a Scratch extension that talks to the Rust backend in
 * `E:\cpp\Claw\backend`. See `docs/PROTOCOL.md` for the wire contract.
 *
 * Every remote block returns a Promise, so scratch-vm parks the thread in
 * STATUS_PROMISE_WAIT and the round trip is genuinely asynchronous: the project
 * keeps rendering while the request is in flight.
 *
 * Network failures are never thrown — they resolve to a neutral value and land
 * in `lastError`, because a rejected promise would kill the whole script.
 */

'use strict';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8971';
const REQUEST_TIMEOUT_MS = 5000;

/** Argument types understood by scratch-vm's extension converter. */
const ARG = {
    STRING: 'string',
    NUMBER: 'number',
    BOOLEAN: 'Boolean'
};

const OPS = [
    { label: '加 a+b', value: 'add' },
    { label: '减 a-b', value: 'sub' },
    { label: '乘 a×b', value: 'mul' },
    { label: '除 a÷b', value: 'div' },
    { label: '幂 a^b', value: 'pow' },
    { label: '平方根 √a', value: 'sqrt' },
    { label: 'SHA-1', value: 'sha1' },
    { label: '反转文本', value: 'reverse' },
    { label: '词数', value: 'wordcount' },
    { label: '是否素数', value: 'prime' },
    { label: '斐波那契', value: 'fib' }
];

/**
 * Monotonic millisecond clock. `Date.now()` has 1ms granularity, and a
 * loopback request can finish inside the same millisecond it started, which
 * made latency readings come back as a misleading 0. Falls back to `Date.now`
 * where `performance` is unavailable.
 * @returns {number} milliseconds, fractional when supported
 */
function nowMs () {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

class ClawBridge {
    /**
     * @param {object} [runtime] - scratch-vm runtime; unused today but part of
     * the constructor contract the VM expects.
     */
    constructor (runtime) {
        this.runtime = runtime;

        /** Base URL of the backend. */
        this.baseUrl = DEFAULT_BASE_URL;

        /** Last error message, or '' when the previous call succeeded. */
        this.lastError = '';

        /** Round-trip time of the most recent request, in ms. */
        this.lastLatency = 0;

        /** Number of requests issued so far. */
        this.requestCount = 0;

        /** Cached result of the most recent health check. */
        this.online = false;
        this.version = '';
    }

    // ---------------------------------------------------------------- info

    getInfo () {
        return {
            id: 'clawbridge',
            name: 'Claw 后端',
            color1: '#2b6cb0',
            color2: '#2c5282',
            color3: '#1a365d',
            blocks: [
                {
                    opcode: 'health',
                    blockType: 'reporter',
                    text: '连接状态',
                    arguments: {}
                },
                {
                    opcode: 'backendVersion',
                    blockType: 'reporter',
                    text: '后端版本',
                    arguments: {}
                },
                {
                    opcode: 'getLastLatency',
                    blockType: 'reporter',
                    text: '上次延迟 (毫秒)',
                    arguments: {}
                },
                {
                    opcode: 'getLastError',
                    blockType: 'reporter',
                    text: '最后的错误',
                    arguments: {}
                },
                {
                    opcode: 'setBaseUrl',
                    blockType: 'command',
                    text: '设置后端地址为 [URL]',
                    arguments: {
                        URL: { type: ARG.STRING, defaultValue: DEFAULT_BASE_URL }
                    }
                },
                '---',
                {
                    opcode: 'echo',
                    blockType: 'reporter',
                    text: '发送 [MESSAGE] 并回显',
                    arguments: {
                        MESSAGE: { type: ARG.STRING, defaultValue: '你好' }
                    }
                },
                '---',
                {
                    opcode: 'compute',
                    blockType: 'reporter',
                    text: '在服务端计算 [OP] a=[A] b=[B] 文本=[TEXT]',
                    arguments: {
                        OP: { type: ARG.STRING, menu: 'op', defaultValue: 'add' },
                        A: { type: ARG.NUMBER, defaultValue: 2 },
                        B: { type: ARG.NUMBER, defaultValue: 3 },
                        TEXT: { type: ARG.STRING, defaultValue: 'abc' }
                    }
                },
                '---',
                {
                    opcode: 'counterValue',
                    blockType: 'reporter',
                    text: '计数器值',
                    arguments: {}
                },
                {
                    opcode: 'counterAdd',
                    blockType: 'command',
                    text: '计数器增加 [DELTA]',
                    arguments: {
                        DELTA: { type: ARG.NUMBER, defaultValue: 1 }
                    }
                },
                '---',
                {
                    opcode: 'request',
                    blockType: 'reporter',
                    text: '原始请求 [METHOD] [PATH] 正文 [BODY]',
                    arguments: {
                        METHOD: { type: ARG.STRING, menu: 'method', defaultValue: 'GET' },
                        PATH: { type: ARG.STRING, defaultValue: '/api/health' },
                        BODY: { type: ARG.STRING, defaultValue: '' }
                    }
                }
            ],
            menus: {
                op: { acceptReporters: true, items: OPS },
                method: { acceptReporters: true, items: ['GET', 'POST'] }
            }
        };
    }

    // ------------------------------------------------------------ plumbing

    /**
     * Issue one JSON request against the backend.
     *
     * Never rejects: transport/parse failures resolve to `null` and are
     * recorded in `this.lastError`. A `{ok: false}` body is also an error.
     *
     * @param {string} method - 'GET' or 'POST'
     * @param {string} path - e.g. '/api/health'
     * @param {object} [body] - JSON body for POST
     * @returns {Promise<object|null>} the parsed body, or null on failure
     */
    async _request (method, path, body) {
        const url = this.baseUrl.replace(/\/+$/, '') + path;
        const started = nowMs();
        this.requestCount += 1;

        // AbortController keeps a hung backend from freezing the project.
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;

        try {
            const init = {
                method,
                headers: { 'Content-Type': 'application/json' }
            };
            if (controller) init.signal = controller.signal;
            if (body !== undefined && method !== 'GET') {
                init.body = JSON.stringify(body);
            }

            const res = await fetch(url, init);
            const text = await res.text();

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (parseError) {
                this.lastError = `响应不是 JSON (HTTP ${res.status})`;
                return null;
            }

            this.lastLatency = nowMs() - started;

            if (!res.ok || parsed.ok === false) {
                this.lastError = parsed.error || `HTTP ${res.status}`;
                return null;
            }

            this.lastError = '';
            return parsed;
        } catch (error) {
            this.lastLatency = nowMs() - started;
            // AbortError means the timeout fired; anything else is a transport error.
            this.lastError = error && error.name === 'AbortError' ?
                `请求超时 (${REQUEST_TIMEOUT_MS}ms)` :
                `无法连接后端: ${(error && error.message) || error}`;
            return null;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /** Coerce anything the VM hands us into a finite number. */
    static toNumber (value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    /** Coerce anything the VM hands us into a string. */
    static toText (value) {
        if (typeof value === 'string') return value;
        if (value === undefined || value === null) return '';
        return String(value);
    }

    // -------------------------------------------------------------- blocks

    async health () {
        const body = await this._request('GET', '/api/health');
        if (!body) {
            this.online = false;
            return '离线';
        }
        this.online = true;
        this.version = String(body.version || '');
        return `在线 v${this.version} · ${Math.max(1, Math.round(this.lastLatency))}ms`;
    }

    async backendVersion () {
        const body = await this._request('GET', '/api/health');
        if (!body) return '';
        this.version = String(body.version || '');
        return this.version;
    }

    // NOTE: these must not share a name with the `lastLatency` / `lastError`
    // *properties* set in `_request` — an own data property would shadow the
    // prototype method and the block would throw "not a function".
    getLastLatency () {
        return this.lastLatency;
    }

    getLastError () {
        return this.lastError;
    }

    setBaseUrl (args) {
        const next = ClawBridge.toText(args && args.URL).trim();
        this.baseUrl = next || DEFAULT_BASE_URL;
        this.lastError = '';
        return '';
    }

    async echo (args) {
        const message = ClawBridge.toText(args && args.MESSAGE);
        const body = await this._request('POST', '/api/echo', { message });
        if (!body) return '';
        return ClawBridge.toText(body.echo);
    }

    async compute (args) {
        const op = ClawBridge.toText(args && args.OP) || 'add';
        const payload = {
            op,
            a: ClawBridge.toNumber(args && args.A),
            b: ClawBridge.toNumber(args && args.B),
            text: ClawBridge.toText(args && args.TEXT)
        };
        const body = await this._request('POST', '/api/compute', payload);
        if (!body) return '';
        // Booleans and numbers keep their type; Scratch is happy with both, and
        // returning '' on error keeps the block usable in a "join" slot.
        return body.result === undefined || body.result === null ? '' : body.result;
    }

    async counterValue () {
        const body = await this._request('GET', '/api/counter');
        if (!body) return 0;
        return ClawBridge.toNumber(body.value);
    }

    async counterAdd (args) {
        const delta = ClawBridge.toNumber(args && args.DELTA);
        await this._request('POST', '/api/counter', { delta });
        return '';
    }

    /**
     * Escape hatch: raw request, returned as a JSON string so the project can
     * post-process it with ordinary string blocks.
     */
    async request (args) {
        const method = (ClawBridge.toText(args && args.METHOD) || 'GET').toUpperCase();
        const path = ClawBridge.toText(args && args.PATH) || '/api/health';
        const rawBody = ClawBridge.toText(args && args.BODY);

        let parsedBody;
        if (rawBody.trim() !== '') {
            try {
                parsedBody = JSON.parse(rawBody);
            } catch (parseError) {
                this.lastError = '请求正文不是合法 JSON';
                return '';
            }
        }

        const body = await this._request(method, path, parsedBody);
        if (!body) return '';
        return JSON.stringify(body);
    }
}

// ---------------------------------------------------------------------------
// 双环境导出
//
// 同一个文件要能被三种方式加载：
//   1. node（headless 测试）：`require(...)` 拿到构造器。
//   2. scratch-vm 的 Web Worker：由 `extension-worker.js` 用 importScripts()
//      直接执行。那里没有 `module`，唯一的约定是 `Scratch.extensions.register`。
//   3. 试验台页面的 CommonJS shim（new Function('module','exports',...)）。
//
// 所以只在 module/exports 存在时才写 CommonJS 导出，并且顺手在浏览器环境下
// 自动注册 —— 这样把本文件地址填进 TurboWarp / Scratch 的「加载扩展」即可用。
// ---------------------------------------------------------------------------
if (typeof module === 'object' && module && module.exports) {
    module.exports = ClawBridge;
    module.exports.ClawBridge = ClawBridge;
    module.exports.instanceFor = runtime => new ClawBridge(runtime);
    module.exports.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
}

// Worker 环境：Scratch.extensions.register(instance) 必须在脚本同步执行期间调用，
// 否则 extension-worker.js 已经读完 importScripts 并去等 initialRegistrations 了。
if (typeof Scratch !== 'undefined' && Scratch && Scratch.extensions &&
        typeof Scratch.extensions.register === 'function') {
    Scratch.extensions.register(new ClawBridge(null));
}
