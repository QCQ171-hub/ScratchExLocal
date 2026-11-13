// Smoke test for the Claw Bridge backend, driven over real HTTP.
// Usage: node scripts/smoke-backend.mjs [baseUrl]
// No dependencies: uses global fetch (Node 18+).

const BASE = (process.argv[2] || 'http://127.0.0.1:8971').replace(/\/$/, '');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failed++;
        failures.push(`${name}${detail ? ' :: ' + detail : ''}`);
        console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`);
    }
}

function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

async function json(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(BASE + path, init);
    const text = await res.text();
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = { __unparsable: text };
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
}

async function main() {
    console.log(`\n== Claw Bridge backend smoke test -> ${BASE}\n`);

    // 1. health
    const h = await json('GET', '/api/health');
    check('health 200', h.status === 200, `status ${h.status}`);
    eq('health ok=true', h.body.ok, true);
    eq('health service', h.body.service, 'claw-backend');
    check('health version is a string', typeof h.body.version === 'string', String(h.body.version));
    check('health uptime_ms is a number', typeof h.body.uptime_ms === 'number', String(h.body.uptime_ms));
    check('health requests is a number', typeof h.body.requests === 'number', String(h.body.requests));

    // 2. CORS headers on a normal response
    eq('cors allow-origin', h.headers.get('access-control-allow-origin'), '*');
    eq('cors allow-methods', h.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    eq('cors allow-headers', h.headers.get('access-control-allow-headers'), 'Content-Type');

    // 3. preflight
    const pre = await fetch(BASE + '/api/compute', { method: 'OPTIONS' });
    eq('preflight status', pre.status, 204);
    eq('preflight allow-origin', pre.headers.get('access-control-allow-origin'), '*');

    // 4. echo
    const e = await json('POST', '/api/echo', { message: 'hello 爪子' });
    eq('echo ok', e.body.ok, true);
    eq('echo roundtrip (unicode)', e.body.echo, 'hello 爪子');
    check('echo received_at_ms is a number', typeof e.body.received_at_ms === 'number', String(e.body.received_at_ms));

    // 5. echo with empty body -> empty message
    const e2 = await json('POST', '/api/echo');
    eq('echo empty body ok', e2.body.ok, true);
    eq('echo empty body message', e2.body.echo, '');

    // 6. echo with malformed JSON must be a 400, not a silent default
    const bad = await json('POST', '/api/echo', '{"message":');
    eq('malformed json status', bad.status, 400);
    eq('malformed json ok=false', bad.body.ok, false);

    // 7. compute ops
    const cases = [
        ['add', { op: 'add', a: 2, b: 3 }, 5],
        ['sub', { op: 'sub', a: 2, b: 3 }, -1],
        ['mul', { op: 'mul', a: 6, b: 7 }, 42],
        ['div', { op: 'div', a: 6, b: 3 }, 2],
        ['pow', { op: 'pow', a: 2, b: 10 }, 1024],
        ['sqrt', { op: 'sqrt', a: 81 }, 9],
        ['sha1', { op: 'sha1', text: 'abc' }, 'a9993e364706816aba3e25717850c26c9cd0d89d'],
        ['reverse', { op: 'reverse', text: '爪哇你好' }, '好你哇爪'],
        ['wordcount', { op: 'wordcount', text: '  a b\tc\nd ' }, 4],
        ['prime true', { op: 'prime', a: 97 }, true],
        ['prime false', { op: 'prime', a: 91 }, false],
        ['fib 10', { op: 'fib', a: 10 }, 55],
        ['fib 90', { op: 'fib', a: 90 }, 2880067194370816120]
    ];
    for (const [name, body, expected] of cases) {
        const r = await json('POST', '/api/compute', body);
        check(`compute ${name} ok`, r.body.ok === true, JSON.stringify(r.body));
        if (typeof expected === 'number' && typeof r.body.result === 'number') {
            check(`compute ${name} value`, Math.abs(r.body.result - expected) < 1e-9, `${r.body.result} vs ${expected}`);
        } else {
            eq(`compute ${name} value`, r.body.result, expected);
        }
    }

    // 8. compute errors -> 400 with ok=false
    const errCases = [
        ['div by zero', { op: 'div', a: 1, b: 0 }],
        ['sqrt negative', { op: 'sqrt', a: -1 }],
        ['prime negative', { op: 'prime', a: -3 }],
        ['fib too big', { op: 'fib', a: 91 }],
        ['unknown op', { op: 'nope' }]
    ];
    for (const [name, body] of errCases) {
        const r = await json('POST', '/api/compute', body);
        eq(`compute error ${name} status`, r.status, 400);
        eq(`compute error ${name} ok=false`, r.body.ok, false);
        check(`compute error ${name} has error message`, typeof r.body.error === 'string' && r.body.error.length > 0, JSON.stringify(r.body));
    }

    // 9. counter: default delta is +1, including an empty body
    const before = (await json('GET', '/api/counter')).body.value;
    const c1 = await json('POST', '/api/counter');
    eq('counter empty body delta=+1', c1.body.value, before + 1);
    const c2 = await json('POST', '/api/counter', { delta: 10 });
    eq('counter explicit delta', c2.body.value, before + 11);
    const c3 = await json('GET', '/api/counter');
    eq('counter persists', c3.body.value, before + 11);

    // 10. static file serving
    const s = await fetch(BASE + '/serve/docs/PROTOCOL.md');
    eq('serve existing file status', s.status, 200);
    const servedType = s.headers.get('content-type') || '';
    check('serve sets a content-type', servedType.length > 0, servedType);
    const servedBody = await s.text();
    check('serve returns real content', servedBody.includes('Claw Bridge 协议契约'), servedBody.slice(0, 60));

    const jsFile = await fetch(BASE + '/serve/extension/claw-bridge/index.js');
    eq('serve js status', jsFile.status, 200);
    check('serve js content-type', (jsFile.headers.get('content-type') || '').startsWith('text/javascript'), jsFile.headers.get('content-type'));

    const missing = await fetch(BASE + '/serve/docs/definitely-not-here.txt');
    eq('serve missing -> 404', missing.status, 404);

    // 11. directory traversal must be refused
    for (const evil of [
        '/serve/../backend/Cargo.toml',
        '/serve/%2e%2e/backend/Cargo.toml',
        '/serve/..%2f..%2fWindows/win.ini',
        '/serve/C:/Windows/win.ini'
    ]) {
        const r = await fetch(BASE + evil);
        check(`traversal blocked ${evil}`, r.status === 403 || r.status === 404, `status ${r.status}`);
    }

    // 12. unknown endpoint / method
    const nf = await json('GET', '/definitely-not-a-route');
    eq('unknown route -> 404', nf.status, 404);
    eq('unknown route ok=false', nf.body.ok, false);

    const wrongMethod = await json('GET', '/api/echo');
    eq('wrong method -> 405', wrongMethod.status, 405);
    eq('wrong method ok=false', wrongMethod.body.ok, false);

    console.log(`\n== ${passed} passed, ${failed} failed ==\n`);
    if (failed > 0) {
        console.log('Failures:');
        for (const f of failures) console.log('  - ' + f);
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error('\nSmoke test crashed:', err);
    process.exitCode = 1;
});
