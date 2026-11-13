# Claw Bridge 协议契约 (v1)

本文件是 **唯一权威契约**。Rust 后端、Scratch 拓展、测试脚本都必须严格按此实现，
不得擅自更改字段名 / 路径 / 端口。要改契约必须先改本文件并通知 Lead。

## 1. 基础

- 监听地址：`127.0.0.1:8971`
- 协议：HTTP/1.1 + JSON (UTF-8)
- 所有响应 `Content-Type: application/json; charset=utf-8`
- 所有 JSON 响应都含布尔字段 `ok`。
  - 成功：`{"ok": true, ...业务字段}`
  - 失败：`{"ok": false, "error": "<人类可读信息>"}`，HTTP 状态码 400 / 404 / 405 / 500

### CORS（必须）

每个响应都要带：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Max-Age: 86400
```

`OPTIONS` 任意路径 → `204 No Content` 且带上述头（预检必须通过）。

## 2. 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 运行时统计 |
| POST | `/api/echo` | 回显 |
| POST | `/api/compute` | 服务端计算（op 分派） |
| GET | `/api/counter` | 读计数器 |
| POST | `/api/counter` | 累加计数器 |
| GET | `/serve/*path` | 静态文件（只读，工作区根目录） |

### 2.1 GET /api/health

响应 200：

```json
{
  "ok": true,
  "service": "claw-backend",
  "version": "0.1.0",
  "uptime_ms": 1234,
  "requests": 7
}
```

- `uptime_ms`：进程启动到现在的毫秒数（u64）
- `requests`：已处理请求总数（u64，含本次）—— 用于让拓展演示真实往返

### 2.2 POST /api/echo

请求：`{"message": "任意字符串"}`

响应 200：`{"ok": true, "echo": "<原样>", "received_at_ms": 1730000000000}`

- `message` 缺失 → 视为 `""`
- `received_at_ms`：Unix 毫秒时间戳（u64）

### 2.3 POST /api/compute

请求：

```json
{"op": "<op 名>", "a": 1.0, "b": 2.0, "text": "abc"}
```

- `a` / `b` 可选，f64，缺省 `0.0`
- `text` 可选，字符串，缺省 `""`

响应 200：`{"ok": true, "op": "<op>", "result": <string | number | boolean>}`

支持的 `op`：

| op | 入参 | result 类型 | 说明 |
| --- | --- | --- | --- |
| `add` | a, b | number | a + b |
| `sub` | a, b | number | a - b |
| `mul` | a, b | number | a * b |
| `div` | a, b | number | a / b；b == 0 → 400 |
| `pow` | a, b | number | a 的 b 次幂 |
| `sqrt` | a | number | a 的平方根；a < 0 → 400 |
| `sha1` | text | string | SHA-1 十六进制小写 |
| `reverse` | text | string | 按 Unicode 字符反转 |
| `wordcount` | text | number | 空白分词后的词数 |
| `prime` | a | boolean | a 取整为 u64 后是否素数（a<0 或非整数 → 400） |
| `fib` | a | number | 斐波那契第 `a` 项（0≤a≤90，超界 → 400） |

未知 `op` → 400 `{"ok": false, "error": "unknown op: <op>"}`

### 2.4 GET /api/counter

响应 200：`{"ok": true, "value": <i64>}`

### 2.5 POST /api/counter

请求：`{"delta": 1}`（可省略，默认 1，i64）

响应 200：`{"ok": true, "value": <累加后的 i64>}`

计数器必须在多线程并发下正确（用 `AtomicI64` 或 Mutex）。

### 2.6 GET /serve/*path

从**工作区根目录**（后端进程 cwd 的父级，或环境变量 `CLAW_ROOT` 指定）读取文件原样返回。

- 必须防目录穿越：拒绝解析后不在根目录内的路径（403）
- 不存在的文件 → 404
- Content-Type 按扩展名：`.js` → `text/javascript; charset=utf-8`，
  `.html` → `text/html; charset=utf-8`，`.json` → `application/json; charset=utf-8`，
  `.css` → `text/css; charset=utf-8`，其它 → `application/octet-stream`

## 3. Scratch 拓展约定

- 文件：`E:\cpp\Claw\extension\claw-bridge\index.js`
- 拓展 id：`clawbridge`（只能是 `[A-Za-z0-9]`）
- 拓展名：`Claw 后端`
- 缺省基址：`http://127.0.0.1:8971`
- 所有远程块返回 **Promise**（scratch-vm 的 `STATUS_PROMISE_WAIT` 会挂起线程等待）
- 网络失败不得抛异常：统一 catch 后返回 `""` / `false` / `0`，并把错误存进 `lastError`
- 必须同时支持：
  - Node（headless 测试）：`module.exports = ClawBridge` 且 `module.exports.instanceFor = runtime => new ClawBridge(runtime)`
  - TurboWarp 无沙箱加载：若存在 `globalThis.Scratch?.extensions?.register`
    且能拿到 runtime，则注册实例；否则挂 `globalThis.ClawBridge = ClawBridge`
