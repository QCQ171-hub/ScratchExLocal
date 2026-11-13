#!/usr/bin/env node
/**
 * patch-scratch-vm.mjs — 修复 scratch-vm 上游的 Worker 调度缺陷。
 *
 * 通过真实 `Worker` 加载扩展（`vm.extensionManager.loadExtensionURL(...)`）后，
 * 调用任意扩展积木都会抛 DataCloneError。这是**两个**独立的缺陷叠在一起：
 *
 * ## 缺陷 1：`util` 不再是最后一个参数
 *
 * `src/extension-support/extension-manager.js` 里积木包装函数是：
 *
 *     blockInfo.func = (args, util) => {
 *         const realBlockInfo = getBlockInfo(args);
 *         return callBlockFunc(args, util, realBlockInfo);
 *     };
 *
 * 服务在 Worker 上时 `callBlockFunc` 变成
 * `(args, util, realBlockInfo) => dispatch.call(serviceName, funcName, args, util, realBlockInfo)`，
 * 于是 util 落在 args 数组的**倒数第二个**位置。
 *
 * 而 `src/dispatch/shared-dispatch.js` 的 `_remoteTransferCall` 里只有一段旧 hack：
 *
 *     if ((args.length > 0) && (typeof args[args.length - 1].yield === 'function')) {
 *         args.pop();
 *     }
 *
 * 它假设 util 永远是**最后一个**参数，加入 `realBlockInfo` 之后这个假设失效，
 * `BlockUtility` 实例（带 sequencer / thread 等不可结构化克隆的对象）被原样
 * postMessage → DataCloneError。
 *
 * ## 缺陷 2：`realBlockInfo` 自身带着不可克隆的 `func` 闭包
 *
 * 即使 util 被清掉，第三个实参 `realBlockInfo` 就是 `blockInfo` 本身，
 * 而 `blockInfo.func = (args, util) => {...}` 在它上面挂了一个箭头函数。
 * 结构化克隆拒绝函数 → 仍然 DataCloneError，报错会点名那个箭头函数。
 *
 * ## 修法
 *
 * 1. `_remoteTransferCall`：遍历所有参数，凡是 BlockUtility 形状（带 `yield` 函数）
 *    的槽位替换为 `undefined`。用 `undefined` 占位而不是 splice 删除，是为了
 *    **保住参数位置**：worker 侧 `provider[method].apply(provider, args)` 仍要把
 *    realBlockInfo 送到第三个形参上。直接删除会把它挤到 util 的位置。
 * 2. `extension-manager` 的远程分支：发送前把 `realBlockInfo` 浅拷贝一份并剔除 `func`。
 *    其余字段（opcode / blockType / text / arguments…）都是纯数据，克隆没问题。
 *
 * 每处修改都会留下带 `patched by scripts/patch-scratch-vm.mjs` 的注释，因此可重复执行。
 *
 * ## 用法
 *
 *     node scripts/patch-scratch-vm.mjs            # 打补丁（幂等）
 *     node scripts/patch-scratch-vm.mjs --check    # 只检查，不写入
 *     node scripts/patch-scratch-vm.mjs --revert   # 还原
 *
 * 退出码：0 = 全部就绪，1 = 有文件既没打过也无法匹配，2 = 用法错误。
 */

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VM_DIR = path.join(ROOT, 'harness', 'node_modules', 'scratch-vm');

/** 所有补丁共用的标记前缀。 */
const MARKER = 'patched by scripts/patch-scratch-vm.mjs';

/**
 * 每一组补丁：作用在哪些文件、原代码、替换代码、以及该组专属的「已打过」标记。
 * `marker` 必须能在 `fixed` 里找到——它就是幂等判断的依据。
 */
const PATCHES = [
    {
        title: 'shared-dispatch: util 不再是最后一个参数（src）',
        file: 'src/dispatch/shared-dispatch.js',
        marker: '`util` is no longer the last argument',
        broken: [
            '            /** @TODO: remove this hack! this is just here so we don\'t try to send `util` to a worker */',
            '            if ((args.length > 0) && (typeof args[args.length - 1].yield === \'function\')) {',
            '                args.pop();',
            '            }'
        ].join('\n'),
        fixed: [
            '            /** @TODO: remove this hack! this is just here so we don\'t try to send `util` to a worker */',
            '            // patched by scripts/patch-scratch-vm.mjs: `util` is no longer the last argument',
            '            // (realBlockInfo follows it), so blank out every BlockUtility-shaped slot instead of',
            '            // popping the tail. Keeping the slot (as `undefined`) preserves the argument order',
            '            // that the worker side relies on.',
            '            for (let i = 0; i < args.length; i++) {',
            '                if (args[i] && (typeof args[i].yield === \'function\')) {',
            '                    args[i] = undefined;',
            '                }',
            '            }'
        ].join('\n')
    },
    {
        title: 'shared-dispatch: util 不再是最后一个参数（dist）',
        files: ['dist/web/scratch-vm.js', 'dist/node/scratch-vm.js'],
        marker: '`util` is no longer the last argument',
        broken: [
            '      /** @TODO: remove this hack! this is just here so we don\'t try to send `util` to a worker */',
            '      if (args.length > 0 && typeof args[args.length - 1].yield === \'function\') {',
            '        args.pop();',
            '      }'
        ].join('\n'),
        fixed: [
            '      /** @TODO: remove this hack! this is just here so we don\'t try to send `util` to a worker */',
            '      // patched by scripts/patch-scratch-vm.mjs: `util` is no longer the last argument',
            '      for (let i = 0; i < args.length; i++) {',
            '        if (args[i] && typeof args[i].yield === \'function\') {',
            '          args[i] = undefined;',
            '        }',
            '      }'
        ].join('\n')
    },
    {
        title: 'extension-manager: realBlockInfo 带 func 闭包（src）',
        file: 'src/extension-support/extension-manager.js',
        marker: '`realBlockInfo` is `blockInfo` itself',
        broken: [
            '                if (dispatch._isRemoteService(serviceName)) {',
            '                    return (args, util, realBlockInfo) =>',
            '                        dispatch.call(serviceName, funcName, args, util, realBlockInfo);',
            '                }'
        ].join('\n'),
        fixed: [
            '                if (dispatch._isRemoteService(serviceName)) {',
            '                    // patched by scripts/patch-scratch-vm.mjs: `realBlockInfo` is `blockInfo` itself,',
            '                    // which carries a `func` closure that cannot be structured-cloned across the',
            '                    // Worker boundary. Send a shallow copy without the non-cloneable `func`.',
            '                    return (args, util, realBlockInfo) => {',
            '                        let payload = realBlockInfo;',
            '                        if (realBlockInfo && typeof realBlockInfo === \'object\') {',
            '                            payload = {};',
            '                            for (const key of Object.keys(realBlockInfo)) {',
            '                                if (key !== \'func\') payload[key] = realBlockInfo[key];',
            '                            }',
            '                        }',
            '                        return dispatch.call(serviceName, funcName, args, util, payload);',
            '                    };',
            '                }'
        ].join('\n')
    },
    {
        title: 'extension-manager: realBlockInfo 带 func 闭包（dist）',
        files: ['dist/web/scratch-vm.js', 'dist/node/scratch-vm.js'],
        marker: '`realBlockInfo` is `blockInfo` itself',
        broken: [
            '            if (dispatch._isRemoteService(serviceName)) {',
            '              return (args, util, realBlockInfo) => dispatch.call(serviceName, funcName, args, util, realBlockInfo);',
            '            }'
        ].join('\n'),
        fixed: [
            '            if (dispatch._isRemoteService(serviceName)) {',
            '              // patched by scripts/patch-scratch-vm.mjs: `realBlockInfo` is `blockInfo` itself,',
            '              // which carries a `func` closure that cannot be structured-cloned.',
            '              return (args, util, realBlockInfo) => {',
            '                let payload = realBlockInfo;',
            '                if (realBlockInfo && typeof realBlockInfo === \'object\') {',
            '                  payload = {};',
            '                  for (const key of Object.keys(realBlockInfo)) {',
            '                    if (key !== \'func\') payload[key] = realBlockInfo[key];',
            '                  }',
            '                }',
            '                return dispatch.call(serviceName, funcName, args, util, payload);',
            '              };',
            '            }'
        ].join('\n')
    }
];

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const REVERT = argv.includes('--revert');
const unknown = argv.filter(a => !['--check', '--revert', '--help'].includes(a));
if (unknown.length || argv.includes('--help')) {
    console.error('usage: node scripts/patch-scratch-vm.mjs [--check | --revert]');
    process.exit(2);
}

if (!existsSync(VM_DIR)) {
    console.error(`scratch-vm 未安装：${VM_DIR}`);
    console.error('先运行 scripts/install-frontend.cmd（或 npm install --prefix harness ...）。');
    process.exit(1);
}

let changed = 0;
let already = 0;
let failed = 0;

for (const patch of PATCHES) {
    const files = patch.files || [patch.file];
    for (const rel of files) {
        const full = path.join(VM_DIR, rel);
        if (!existsSync(full)) {
            console.log(`  skip    ${rel}（文件不存在）`);
            continue;
        }
        const source = readFileSync(full, 'utf8');
        const from = REVERT ? patch.fixed : patch.broken;
        const to = REVERT ? patch.broken : patch.fixed;

        if (!REVERT && source.includes(patch.marker)) {
            console.log(`  ok      ${rel} · ${patch.title}`);
            already++;
            continue;
        }
        if (REVERT && !source.includes(patch.marker)) {
            console.log(`  skip    ${rel} · ${patch.title}（没有补丁标记）`);
            continue;
        }

        if (!source.includes(from)) {
            console.error(`  FAIL    ${rel} · ${patch.title}`);
            if (!REVERT) console.error('          找不到待修改的代码块，可能需要重新核对 scratch-vm 版本。');
            failed++;
            continue;
        }
        if (source.indexOf(from) !== source.lastIndexOf(from)) {
            console.error(`  FAIL    ${rel} · ${patch.title}：代码块出现多次，拒绝盲目替换`);
            failed++;
            continue;
        }

        if (CHECK_ONLY) {
            console.log(`  would   ${rel} · ${patch.title}`);
            changed++;
            continue;
        }
        writeFileSync(full, source.replace(from, to), 'utf8');
        console.log(`  ${REVERT ? 'revert ' : 'patch  '} ${rel} · ${patch.title}`);
        changed++;
    }
}

console.log('');
if (failed) {
    console.error(`完成，但有 ${failed} 处失败。`);
    process.exit(1);
}
if (CHECK_ONLY) {
    console.log(changed ? `${changed} 处需要处理。` : `全部就绪（${already} 处此前已打过）。`);
} else if (REVERT) {
    console.log(changed ? `已还原 ${changed} 处。` : '没有需要还原的补丁。');
} else {
    console.log(changed
        ? `已打补丁 ${changed} 处${already ? `（另有 ${already} 处此前已打过）` : ''}。刷新页面即可生效。`
        : `全部 ${already} 处此前已打过，无需改动。`);
}
