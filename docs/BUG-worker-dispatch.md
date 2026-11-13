# BUG / 事后分析：Worker 模式下调用扩展积木抛 `DataCloneError`

**一句话**：`scratch-vm` 的「主线程 → Worker」调度层里有两处叠加的上游缺陷，任何扩展只要走真实编辑器的
`loadExtensionURL()` 路径，调用第一个积木就会抛 `DataCloneError`。本项目用 `scripts/patch-scratch-vm.mjs`
在本地打两个补丁绕过，**进程内注入路径（本地试验台、node 测试）完全不受影响**。

| 项 | 值 |
| --- | --- |
| 缺陷归属 | 上游 `scratchfoundation/scratch-vm`，不是本项目的扩展或后端 |
| 受影响版本 | `scratch-vm@5.0.300`（`npmmirror` 上的 `dist-tags.latest`） |
| 上游现状 | `develop` 分支**仍未修复**（核对时间见下文「上游状态」） |
| 是否与具体扩展有关 | **无关**。官方风格的最小扩展（一个 `ping` reporter）即可复现 |
| 本项目状态 | 已用补丁脚本修复，Worker 路径 9/9 通过；进程内路径 10/10 与 34/34 通过 |

---

## 1. 症状

用编辑器真实加载路径加载扩展——`vm.extensionManager.loadExtensionURL(url)`，内部是
`new Worker('extension-worker.js')` + `importScripts(扩展 url)`——**加载本身成功**，
积木也出现在 `runtime._blockInfo` 里，但**第一次调用任意扩展积木**就抛：

```text
DataCloneError: Failed to execute 'postMessage' on 'Worker':
(args, util) => { const realBlockInfo = getBlockInfo(args); ... } could not be cloned.
```

浏览器里抓到的堆栈（`dist/web/scratch-vm.js`，行号对照见 §3.4）：

```text
at http://127.0.0.1:8971/serve/harness/node_modules/scratch-vm/dist/web/scratch-vm.js:50855:18
at new Promise (<anonymous>)
at CentralDispatch._remoteTransferCall (.../dist/web/scratch-vm.js:50837:12)
at CentralDispatch.transferCall                  (.../dist/web/scratch-vm.js:50785:23)
at CentralDispatch.call                          (.../dist/web/scratch-vm.js:50756:17)
at serviceObject                                 (.../dist/web/scratch-vm.js:58632:62)
at blockInfo.func                                (.../dist/web/scratch-vm.js:58646:20)
at http://127.0.0.1:8971/serve/web/worker-test.html:109:30
```

读法：`blockInfo.func`（主线程侧的积木包装函数）→ `CentralDispatch.call` → `_remoteTransferCall`
→ `provider.postMessage(...)`。也就是说，主线程在把「这次积木调用」打包发给 Worker 时，
**载荷里有东西不能被结构化克隆**，`postMessage` 直接抛 `DataCloneError`，Promise 永不 settle。

> 最后一行 `worker-test.html:109:30` 是**抓取当时**那一版页面的行号；该页面后来重排过，
> 所以现在照行号去对会对不上，看文件名即可。`dist/web/scratch-vm.js` 的行号同理受补丁影响，
> 对照时务必确认是不是同一版本（见 §3.4）。

后续连锁现象：由于这次调用是 `_blockInfo` 填充与首个积木往返的一部分，页面上会看到
「积木注册表里真积木 0 / 只剩 4 个分隔符（共 14 项）」之类的假象——那不是注册失败，
而是注册表的最终填充被这一次抛错打断了。补丁打好后同一页面显示
「真积木 10 / 含分隔符 14」。

## 2. 复现（与具体扩展无关）

只需要 `scratch-vm` 本身 + 一个只声明一个 reporter 积木的最小扩展，不需要本仓库任何代码。

**最小扩展**（`mini-ext.js`，注意没有任何依赖、不碰 `util`）：

```js
class MiniTest {
    getInfo () {
        return {
            id: 'minitest',
            name: 'Mini',
            blocks: [
                {opcode: 'ping', blockType: 'reporter', text: 'ping'}
            ]
        };
    }
    ping () { return 'pong'; }
}

// TurboWarp / unsandboxed 注册方式
if (typeof Scratch !== 'undefined' && Scratch.extensions) {
    Scratch.extensions.register(new MiniTest());
}
if (typeof module !== 'undefined') module.exports = MiniTest;
```

**驱动脚本**（浏览器页面里，或任何注入了 `scratch-vm` 的页面；把上面的
`mini-ext.js` 放到能被 URL 访问到的地方即可，本仓库不预置这个文件）：

```js
const vm = new VirtualMachine();
await vm.extensionManager.loadExtensionURL('/serve/mini-ext.js'); // ← Worker 路径
const ping = vm.runtime.getOpcodeFunction('minitest_ping');
await ping({});   // ← 抛 DataCloneError
```

**判定**：`loadExtensionURL` resolve、`minitest_ping` 能取到、但 `ping({})` 抛
`DataCloneError` ⇒ 命中本缺陷。换成官方文档里的任何示例扩展结果都一样，因为问题在调度层，
不经过扩展自己的代码。（本仓库的 `web/worker-test.html` 用的是真实扩展而不是这个最小扩展，
但走同一条 Worker 路径，因此同样能复现——见 §7。）

## 3. 定位链路

调用链上有两处缺陷，**任一处单独存在都足以让 `postMessage` 失败**，所以补丁脚本一次改两类位置。
注意：实测抓到的报错文案点名的是第二处的箭头函数（§3.3），只看这一行错误信息容易误判成
「只有一处问题」，而按 §5 的补丁 1 单独修好 `util` 之后，仍然会撞上消息体里的那个函数。

### 3.1 主线程侧：每个积木都被包了一层 `blockInfo.func`

`harness/node_modules/scratch-vm/src/extension-support/extension-manager.js:411-431`
（未打补丁的 `5.0.300` / `develop` 行号；打完补丁后这段整体下移，见 §3.4 的注）：

```js
// extension-manager.js:411-431
const callBlockFunc = (() => {
    if (dispatch._isRemoteService(serviceName)) {
        return (args, util, realBlockInfo) =>
            dispatch.call(serviceName, funcName, args, util, realBlockInfo);
    }
    // avoid promise latency if we can call direct
    const serviceObject = dispatch.services[serviceName];
    /* … */
    return (args, util, realBlockInfo) =>
        serviceObject[funcName](args, util, realBlockInfo);
})();

blockInfo.func = (args, util) => {
    const realBlockInfo = getBlockInfo(args);
    // TODO: filter args using the keys of realBlockInfo.arguments? maybe only if sandboxed?
    return callBlockFunc(args, util, realBlockInfo);
};
```

关键点：服务跑在 Worker 上时 `dispatch._isRemoteService(serviceName)` 为真，走上面第一个分支，
于是**送进 `_remoteTransferCall` 的 `args` 数组形状是 `[argValues, util, realBlockInfo]`**。
（本地服务则走 `serviceObject[funcName](args, util, realBlockInfo)`，直接在进程内调用，不涉及克隆。）

### 3.2 缺陷 1：`util` 不再是最后一个参数

`harness/node_modules/scratch-vm/src/dispatch/shared-dispatch.js:127-139`：

```js
// shared-dispatch.js:127-139（缺陷版）
_remoteTransferCall (provider, service, method, transfer, ...args) {
    return new Promise((resolve, reject) => {
        const responseId = this._storeCallbacks(resolve, reject);

        /** @TODO: remove this hack! this is just here so we don't try to send `util` to a worker */
        if ((args.length > 0) && (typeof args[args.length - 1].yield === 'function')) {
            args.pop();
        }

        if (transfer) {
            provider.postMessage({service, method, responseId, args}, transfer);
        } else {
            provider.postMessage({service, method, responseId, args});
        }
    });
}
```

那段 hack 的判据是「**最后一个**参数身上有 `yield` 方法」，命中就 `pop()` 掉。它成立的前提是
`util` 恰好排在数组末尾。加入 `realBlockInfo` 之后，末尾变成了 `realBlockInfo`（它没有 `yield`），
判据失效 → **`BlockUtility` 实例被原样 `postMessage`**。

`BlockUtility`（`src/engine/block-utility.js:107` 定义了 `yield()`，这正是 hack 用来识别它的形状）：

```js
// block-utility.js:107-109
yield () {
    this.thread.status = Thread.STATUS_YIELD;
}
```

判定它「形状像」是因为这个方法，但它同时还挂着 `sequencer`、`thread`、`stackFrame` 等
**带宿主对象/函数的一整棵引用树**，结构化克隆无法复制 ⇒ `DataCloneError`。

### 3.3 缺陷 2：`realBlockInfo` 自己带了一个函数闭包

即使把 `util` 槽位清空，第三个参数仍然过不去：

```js
// extension-manager.js:408-410（补丁前后行号一致，这段没动）
const getBlockInfo = blockInfo.isDynamic ?
    args => args && args.mutation && args.mutation.blockInfo :
    () => blockInfo;
```

非动态积木时 `realBlockInfo` **就是 `blockInfo` 对象本身**，而紧接着的
`blockInfo.func = (args, util) => { … }`（未打补丁时 `:427-431`，打完 `:438-442`）
给它挂了一个闭包属性。结构化克隆规范不支持 `Function`，
于是 `postMessage` 再次失败——**这次报错文案点名的就是那个箭头函数**：

```text
DataCloneError: Failed to execute 'postMessage' on 'Worker':
(args, util) => { const realBlockInfo = getBlockInfo(args); ... } could not be cloned.
```

这也是最容易误判的地方：错误信息读起来像是「你在扩展里传了个函数」，实际上是调度层自己
把积木包装函数塞进了消息体。

### 3.4 编译产物中的位置（`dist/web/scratch-vm.js`）

浏览器加载的是打包后的 `dist`，所以行号要对得上 `dist` 而不是 `src`：

| 位置（未打补丁的 `5.0.300` dist） | 内容 |
| --- | --- |
| `dist/web/scratch-vm.js:50833` | `CentralDispatch._remoteTransferCall(provider, service, method, transfer)` 函数头 |
| `dist/web/scratch-vm.js:50837` | `return new Promise((resolve, reject) => {` |
| `dist/web/scratch-vm.js:50841-50843` | 那段 `args[args.length - 1].yield` + `args.pop()` 的 hack |
| `dist/web/scratch-vm.js:50852` | `provider.postMessage({` —— **抛出点**（`if (transfer)` 的 else 分支） |

> 行号会随补丁位移：本仓库 `util` 补丁把 3 行的 hack 换成 6 行的循环后，
> 抛出点从 `:50852` 变成 `:50855`（§1 抓到的堆栈就是 `:50855:18`），
> 而 `blockInfo.func` 对应的 `src` 行号也从 `427-431` 下移到 `438-442`。
> 对照时报错行号与源码行号要对同一版本，否则会以为「对不上 = 看错文件」。
> `dist/node/scratch-vm.js` 里是同一段代码的另一份产物，补丁脚本一并处理。

## 4. 上游状态（核对结果）

- `scratchfoundation/scratch-vm` 的 **`develop` 分支仍然有问题**：
  `src/extension-support/extension-manager.js:413-431` 依旧是
  「remote 分支带 `realBlockInfo` + `blockInfo.func` 挂闭包」的写法；
  `src/dispatch/shared-dispatch.js:132-133` 依旧是那句「只弹掉最后一个参数」的
  `if ((args.length > 0) && (typeof args[args.length - 1].yield === 'function')) { args.pop(); }`。
- npm 侧：`dist-tags.latest = 5.0.300`（`5.0.300` 发布于 2025-05-04），
  另有预发布 `dist-tags.spork = 5.0.301-spork.1`。**最新发布版同样中招**，
  所以「升级到 latest」不是解法。
- `@turbowarp/scratch-vm` 在 `npmmirror` 上 **不存在（HTTP 404）**，
  本机也没有国际网络（见 `README.md` 的环境限制），因此「换 TurboWarp 的 vm 分支」这条退路在本环境不可用。

> 结论：这是需要上游修的缺陷。本项目只能在本地 `harness/node_modules/` 里打补丁，
> 并把它脚本化、可校验、可回退。

## 5. 修复

```bash
node scripts/patch-scratch-vm.mjs            # 打补丁（幂等，可重复执行）
node scripts/patch-scratch-vm.mjs --check    # 只检查，不写入
node scripts/patch-scratch-vm.mjs --revert   # 还原成上游原样
```

脚本改 **6 处**（`src` 各 2 处 + 两份 `dist` 各 2 处），全部带 `patched by scripts/patch-scratch-vm.mjs`
标记注释便于识别；退出码 `0` = 全部就绪，`1` = 有位置没匹配上（多半是 scratch-vm 换了版本），`2` = 参数错误。

| # | 文件 | 补什么 |
| --- | --- | --- |
| 1 | `src/dispatch/shared-dispatch.js` | `util` 槽位按形状清空 |
| 2 | `dist/web/scratch-vm.js` | 同上（浏览器实际加载的产物） |
| 3 | `dist/node/scratch-vm.js` | 同上（node 侧产物） |
| 4 | `src/extension-support/extension-manager.js` | 发送前剥掉 `realBlockInfo.func` |
| 5 | `dist/web/scratch-vm.js` | 同上 |
| 6 | `dist/node/scratch-vm.js` | 同上 |

### 5.1 补丁 1：按形状清空所有 `util` 槽位

**之前**（`src/dispatch/shared-dispatch.js:131-134`）：

```js
/** @TODO: remove this hack! this is just here so we don't try to send `util` to a worker */
if ((args.length > 0) && (typeof args[args.length - 1].yield === 'function')) {
    args.pop();
}
```

**之后**（`src/dispatch/shared-dispatch.js:131-140`）：

```js
/** @TODO: remove this hack! this is just here so we don't try to send `util` to a worker */
// patched by scripts/patch-scratch-vm.mjs: `util` is no longer the last argument
// (realBlockInfo follows it), so blank out every BlockUtility-shaped slot instead of
// popping the tail. Keeping the slot (as `undefined`) preserves the argument order
// that the worker side relies on.
for (let i = 0; i < args.length; i++) {
    if (args[i] && (typeof args[i].yield === 'function')) {
        args[i] = undefined;
    }
}
```

两个必须守住的细节：

1. **判据仍是 `typeof x.yield === 'function'` 这个形状测试**，而不是「第 2 个参数」这种位置假设——
   位置假设正是原缺陷的成因，换成另一种位置假设只会把 bug 挪个地方。
2. **占位用 `undefined`，绝不能 `splice` 删除**。Worker 侧是
   `provider[method].apply(provider, args)`，靠**实参位置**把 `realBlockInfo` 送到第三个形参；
   直接删元素会把它挤到第二位（也就是 `util` 的位置），扩展就会收到错位的参数。

### 5.2 补丁 2：远程分支发送前剥掉 `func`

**之前**（`src/extension-support/extension-manager.js:412-415`）：

```js
if (dispatch._isRemoteService(serviceName)) {
    return (args, util, realBlockInfo) =>
        dispatch.call(serviceName, funcName, args, util, realBlockInfo);
}
```

**之后**（`src/extension-support/extension-manager.js:412-426`）：

```js
if (dispatch._isRemoteService(serviceName)) {
    // patched by scripts/patch-scratch-vm.mjs: `realBlockInfo` is `blockInfo` itself,
    // which carries a `func` closure that cannot be structured-cloned across the
    // Worker boundary. Send a shallow copy without the non-cloneable `func`.
    return (args, util, realBlockInfo) => {
        let payload = realBlockInfo;
        if (realBlockInfo && typeof realBlockInfo === 'object') {
            payload = {};
            for (const key of Object.keys(realBlockInfo)) {
                if (key !== 'func') payload[key] = realBlockInfo[key];
            }
        }
        return dispatch.call(serviceName, funcName, args, util, payload);
    };
}
```

`realBlockInfo` 的其余字段（`opcode` / `blockType` / `text` / `arguments` / `isDynamic` / `func` 以外的
元数据）都是纯数据，克隆没问题，Worker 侧也只需要这些数据来描述积木。

> ⚠️ 补丁直接改 `harness/node_modules/` 里的文件：**每次 `npm install` 之后要重新跑一次**。
> `node scripts/patch-scratch-vm.mjs --check` 可以随时确认当前状态。

## 6. 影响与取舍

| 场景 | 扩展收到的参数 | 说明 |
| --- | --- | --- |
| Worker 模式（真实 Scratch / TurboWarp 编辑器，打完补丁） | `(args, undefined, realBlockInfo)` | 第二个形参 `util` 是 `undefined`，`realBlockInfo` 在第三位 |
| 进程内注入（`_registerInternalExtension`，本仓库试验台与 node 测试） | `(args, util, realBlockInfo)` | 走 `serviceObject[funcName](...)` 本地分支，`util` **完整可用** |

**Worker 模式下的扩展不应依赖 `util`。** 用 `util` 的场景包括 `util.startBranch(idx, isLoop)`
（做循环积木）、`util.yield()` / `util.yieldTick()`（主动让出时间片）、`util.stackFrame`（保存状态）
——这些在 Worker 模式下会拿到 `undefined` 并抛 `TypeError`。

**本扩展不受这条限制影响**：`extension/claw-bridge/index.js` 完全不碰 `util`（它只靠 HTTP 请求 +
`Promise` 返回，scratch-vm 对 thenable 会自动挂 `STATUS_PROMISE_WAIT`），所以**两种模式都正常**。
这也是当初「把远程积木全部设计成返回 Promise」的一个额外收益。

**进程内注入路径完全不受影响**：`vm.extensionManager._registerInternalExtension(extension)` 走
`provider[method].apply(provider, args)`，不经过 `postMessage`，没有克隆边界，`util` 一切照旧。
`web/index.html`（试验台）和 `scripts/smoke-extension.cjs`（node 测试）用的就是这条路——这也是
「为什么单元测试全绿、真实编辑器里却挂」的答案：两条路径的调度分支不同。

## 7. 验证方式

`web/worker-test.html` 是专门走**真实 Worker 路径**的验证页
（`loadExtensionURL()` → `new Worker('extension-worker.js')` → `importScripts(扩展 url)`），
它把 `window.Worker` 包了一层，把 Worker 的 `error` / `messageerror` 事件也记进日志，
结果写在 `window.__clawWorkerTest = {ok, bad, total, failed:[...]}`。

用 CDP 在 headless Edge 里驱动它：

```bash
node scripts/cdp-probe.mjs http://127.0.0.1:8971/serve/web/worker-test.html 14000
```

打补丁后（实测）：

```text
RESULT: {"ok":9,"bad":0,"total":9,"failed":[]}
  PASS loadExtensionURL 完成（Worker 已加载扩展）
  PASS runtime._blockInfo 出现 clawbridge 分类
  PASS 10 个积木注册到 runtime · 真积木 10 / 含分隔符 14
  PASS 通过 Worker 调用 health 拿到真实响应 · 返回: 在线 v0.1.0 · 1ms
  PASS 通过 Worker 调用 echo 往返 unicode · 返回: worker 往返
  PASS 通过 Worker 调用 compute add 2+3 = 5 · 返回: 5
```

打补丁前同一页面是 7 项里挂 2 项（`10 个积木注册到 runtime`、`加载流程未抛错`），
`failed` 里就是 §1 那条 `DataCloneError`。

### 关键坑：不要用 `--virtual-time-budget`

`node scripts/cdp-probe.mjs <url> [waitMs]`（默认 `waitMs = 12000`）**真实等待**指定毫秒数后
再读结果。这是刻意的：Worker 的握手（起线程 → `importScripts` → `postMessage` 回报）是真实异步，
必须给它真实时间。

如果换成 Chrome/Edge 的 `--virtual-time-budget=<ms>` 去「加速」，虚拟时间会**快进定时器**，
页面上的 `setTimeout` 全部瞬间到期，而 Worker 的握手还在真实 I/O 上没回来 —— 结果就是
补丁明明生效了，验证却稳定报告「超时 / 未注册」。**看到「worker 加载超时」先确认没有开
virtual time，再怀疑补丁。**

同理，`cdp-probe.mjs` 收尾时还会再 evaluate 一次 `window.__clawLog`；只有 Worker 路径页面才有这个
变量，所以某些页面上进程会以退出码 `1` 结束并打印一行 `JSON.parse` 相关错误——
这是探针自身的无害噪声，**以 `RESULT:` 那一行为准**。
