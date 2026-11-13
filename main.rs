//! Claw Bridge backend
//!
//! A tiny, dependency-light HTTP/JSON service that the Scratch extension
//! "Claw 后端" talks to. See `docs/PROTOCOL.md` for the authoritative contract.
//!
//! Run with:
//! ```text
//! cargo run --offline --release
//! ```

use std::{
    net::SocketAddr,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};

use axum::{
    body::Body,
    extract::Path as UrlPath,
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};

const SERVICE_NAME: &str = "claw-backend";
const SERVICE_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_PORT: u16 = 8971;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

struct AppState {
    started: Instant,
    requests: AtomicU64,
    counter: AtomicI64,
    root: PathBuf,
}

impl AppState {
    fn new(root: PathBuf) -> Self {
        Self {
            started: Instant::now(),
            requests: AtomicU64::new(0),
            counter: AtomicI64::new(0),
            root,
        }
    }
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

fn ok_json(value: Value) -> Response {
    let mut res = Json(value).into_response();
    apply_cors(res.headers_mut());
    res
}

fn err_json(status: StatusCode, message: impl Into<String>) -> Response {
    let body = json!({ "ok": false, "error": message.into() });
    let mut res = (status, Json(body)).into_response();
    apply_cors(res.headers_mut());
    res
}

fn apply_cors(headers: &mut axum::http::HeaderMap) {
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
}

/// Preflight for every path, and a real 404 for everything else.
///
/// This is registered as the catch-all route with `any()`, so it must do the
/// method dispatch itself: an `options()`-only route here would make every
/// unknown path answer 405 instead of 404, because matchit resolves the path
/// first and only then rejects the method.
async fn catch_all(method: Method) -> Response {
    if method == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        apply_cors(res.headers_mut());
        res
    } else {
        err_json(StatusCode::NOT_FOUND, "no such endpoint")
    }
}

/// CORS preflight: 204 for every method on every known route.
///
/// Each API route must register this explicitly — a route that only lists
/// `post(...)` answers `OPTIONS` with 405, which fails a browser preflight.
async fn preflight() -> Response {
    let mut res = StatusCode::NO_CONTENT.into_response();
    apply_cors(res.headers_mut());
    res
}

/// Parse an optional JSON body.
///
/// An absent or empty body is `None` (the contract treats it as an empty
/// request). A body that is present but malformed is a hard error, never a
/// silent `None` — `Option<Json<T>>` would swallow it and silently answer with
/// defaults.
fn parse_body<T: DeserializeOwned>(bytes: &[u8]) -> Result<Option<T>, String> {
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    serde_json::from_slice(bytes)
        .map(Some)
        .map_err(|e| format!("invalid JSON body: {e}"))
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health(state: axum::extract::State<Arc<AppState>>) -> Response {
    let seen = state.requests.fetch_add(1, Ordering::SeqCst) + 1;
    ok_json(json!({
        "ok": true,
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "uptime_ms": state.started.elapsed().as_millis() as u64,
        "requests": seen,
    }))
}

#[derive(Debug, Deserialize, Default)]
struct EchoRequest {
    #[serde(default)]
    message: String,
}

async fn echo(
    state: axum::extract::State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    let req: EchoRequest = match parse_body::<EchoRequest>(&body) {
        Ok(Some(v)) => v,
        // Absent/empty body == empty message, per contract.
        Ok(None) => EchoRequest::default(),
        Err(msg) => return err_json(StatusCode::BAD_REQUEST, msg),
    };
    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as u64,
        Err(_) => 0,
    };
    ok_json(json!({
        "ok": true,
        "echo": req.message,
        "received_at_ms": now,
    }))
}

#[derive(Debug, Deserialize, Default)]
struct ComputeRequest {
    #[serde(default)]
    op: String,
    #[serde(default)]
    a: f64,
    #[serde(default)]
    b: f64,
    #[serde(default)]
    text: String,
}

async fn compute(
    state: axum::extract::State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    let req: ComputeRequest = match parse_body::<ComputeRequest>(&body) {
        Ok(Some(v)) => v,
        Ok(None) => ComputeRequest::default(),
        Err(msg) => return err_json(StatusCode::BAD_REQUEST, msg),
    };

    match evaluate(&req) {
        Ok(result) => ok_json(json!({ "ok": true, "op": req.op, "result": result })),
        Err(msg) => err_json(StatusCode::BAD_REQUEST, msg),
    }
}

/// The op dispatch table. Pure, so it is unit-testable without a server.
fn evaluate(req: &ComputeRequest) -> Result<Value, String> {
    let (a, b, text) = (req.a, req.b, req.text.as_str());
    match req.op.as_str() {
        "add" => Ok(json!(a + b)),
        "sub" => Ok(json!(a - b)),
        "mul" => Ok(json!(a * b)),
        "div" => {
            if b == 0.0 {
                Err("division by zero".to_string())
            } else {
                Ok(json!(a / b))
            }
        }
        "pow" => Ok(json!(a.powf(b))),
        "sqrt" => {
            if a < 0.0 {
                Err("sqrt of negative number".to_string())
            } else {
                Ok(json!(a.sqrt()))
            }
        }
        "sha1" => {
            let mut hasher = Sha1::new();
            hasher.update(text.as_bytes());
            let digest = hasher.finalize();
            let mut out = String::with_capacity(40);
            for byte in digest {
                out.push_str(&format!("{byte:02x}"));
            }
            Ok(json!(out))
        }
        "reverse" => Ok(json!(text.chars().rev().collect::<String>())),
        "wordcount" => Ok(json!(text.split_whitespace().count() as u64)),
        "prime" => {
            if a < 0.0 || a.fract() != 0.0 || a > u64::MAX as f64 {
                return Err("prime expects a non-negative integer".to_string());
            }
            Ok(json!(is_prime(a as u64)))
        }
        "fib" => {
            if a < 0.0 || a.fract() != 0.0 {
                return Err("fib expects a non-negative integer".to_string());
            }
            if a > 90.0 {
                return Err("fib index must be <= 90".to_string());
            }
            Ok(json!(fib(a as u64)))
        }
        other => Err(format!("unknown op: {other}")),
    }
}

fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    if n % 2 == 0 {
        return n == 2;
    }
    let mut i = 3u64;
    while i * i <= n {
        if n % i == 0 {
            return false;
        }
        i += 2;
    }
    true
}

fn fib(n: u64) -> u64 {
    // n <= 90 guaranteed by caller; fits in u64.
    let (mut a, mut b) = (0u64, 1u64);
    for _ in 0..n {
        let next = a.wrapping_add(b);
        a = b;
        b = next;
    }
    a
}

async fn counter_get(state: axum::extract::State<Arc<AppState>>) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    let value = state.counter.load(Ordering::SeqCst);
    ok_json(json!({ "ok": true, "value": value }))
}

#[derive(Debug, Deserialize)]
struct CounterRequest {
    #[serde(default = "default_delta")]
    delta: i64,
}

/// Contract default is 1, not 0: `POST /api/counter` with no body increments.
fn default_delta() -> i64 {
    1
}

impl Default for CounterRequest {
    fn default() -> Self {
        Self {
            delta: default_delta(),
        }
    }
}

async fn counter_post(
    state: axum::extract::State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    let delta = match parse_body::<CounterRequest>(&body) {
        Ok(Some(v)) => v.delta,
        Ok(None) => default_delta(),
        Err(msg) => return err_json(StatusCode::BAD_REQUEST, msg),
    };
    let value = state.counter.fetch_add(delta, Ordering::SeqCst) + delta;
    ok_json(json!({ "ok": true, "value": value }))
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Reject any path that could escape the root: no absolute paths, no `..`,
/// and no backslashes (Windows separator smuggling).
fn sanitize_relative(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim_start_matches('/');
    if raw.is_empty() || raw.contains('\\') || raw.contains(':') {
        return None;
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for comp in candidate.components() {
        match comp {
            Component::Normal(part) => clean.push(part),
            _ => return None, // CurDir / ParentDir / RootDir / Prefix
        }
    }
    if clean.as_os_str().is_empty() {
        None
    } else {
        Some(clean)
    }
}

/// Serve `<root>/web/index.html`, so `http://127.0.0.1:8971/` opens the harness.
async fn home(state: axum::extract::State<Arc<AppState>>) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    serve_relative(&state, "web/index.html")
}

async fn serve(
    state: axum::extract::State<Arc<AppState>>,
    UrlPath(raw): UrlPath<String>,
) -> Response {
    state.requests.fetch_add(1, Ordering::SeqCst);
    serve_relative(&state, &raw)
}

/// Resolve and stream one file below the static root.
///
/// Guards, in order: lexical sanitising (rejects `..`, drive letters, absolute
/// paths), then `canonicalize` + containment re-check so a symlink or a
/// Windows short name cannot escape the root either.
fn serve_relative(state: &AppState, raw: &str) -> Response {
    let rel = match sanitize_relative(raw) {
        Some(p) => p,
        None => return err_json(StatusCode::FORBIDDEN, "forbidden path"),
    };
    let full = state.root.join(&rel);

    // Defence in depth: canonicalize and re-check containment.
    let canonical_root = match state.root.canonicalize() {
        Ok(p) => p,
        Err(e) => return err_json(StatusCode::INTERNAL_SERVER_ERROR, format!("bad root: {e}")),
    };
    let canonical = match full.canonicalize() {
        Ok(p) => p,
        Err(_) => return err_json(StatusCode::NOT_FOUND, format!("not found: {raw}")),
    };
    if !canonical.starts_with(&canonical_root) {
        return err_json(StatusCode::FORBIDDEN, "forbidden path");
    }

    let bytes = match std::fs::read(&canonical) {
        Ok(b) => b,
        Err(e) => return err_json(StatusCode::NOT_FOUND, format!("not found: {raw} ({e})")),
    };

    let mut res = Response::new(Body::from(bytes));
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type_for(&canonical)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    apply_cors(headers);
    res
}

async fn not_found() -> Response {
    err_json(StatusCode::NOT_FOUND, "no such endpoint")
}

async fn method_not_allowed() -> Response {
    err_json(StatusCode::METHOD_NOT_ALLOWED, "method not allowed")
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health).options(preflight))
        .route("/api/echo", post(echo).options(preflight))
        .route("/api/compute", post(compute).options(preflight))
        .route(
            "/api/counter",
            get(counter_get).post(counter_post).options(preflight),
        )
        // axum 0.7 / matchit 0.7 syntax: `/*path`, not `/{*path}`.
        .route("/serve/*path", get(serve).options(preflight))
        // Bare root serves the browser harness page.
        .route("/", get(home).options(preflight))
        .route("/*path", axum::routing::any(catch_all))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .with_state(state)
}

/// Workspace root for `/serve/*`. `CLAW_ROOT` wins, otherwise the parent of the
/// current working directory (the backend lives in `<root>/backend`).
fn resolve_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("CLAW_ROOT") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    match cwd.file_name().and_then(|n| n.to_str()) {
        Some("backend") => cwd.parent().map(Path::to_path_buf).unwrap_or(cwd),
        _ => cwd,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port: u16 = std::env::var("CLAW_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let host = std::env::var("CLAW_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());

    let root = resolve_root();
    let state = Arc::new(AppState::new(root.clone()));
    let app = build_router(state);

    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;

    println!("[claw-backend] {SERVICE_NAME} v{SERVICE_VERSION}");
    println!("[claw-backend] listening on http://{addr}");
    println!("[claw-backend] static root: {}", root.display());
    println!("[claw-backend] health: http://{addr}/api/health");

    axum::serve(listener, app).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn req(op: &str, a: f64, b: f64, text: &str) -> ComputeRequest {
        ComputeRequest {
            op: op.to_string(),
            a,
            b,
            text: text.to_string(),
        }
    }

    #[test]
    fn arithmetic_ops() {
        assert_eq!(evaluate(&req("add", 2.0, 3.0, "")).unwrap(), json!(5.0));
        assert_eq!(evaluate(&req("sub", 2.0, 3.0, "")).unwrap(), json!(-1.0));
        assert_eq!(evaluate(&req("mul", 2.0, 3.0, "")).unwrap(), json!(6.0));
        assert_eq!(evaluate(&req("div", 6.0, 3.0, "")).unwrap(), json!(2.0));
    }

    #[test]
    fn division_by_zero_is_an_error() {
        assert!(evaluate(&req("div", 1.0, 0.0, "")).is_err());
    }

    #[test]
    fn sqrt_rejects_negatives() {
        assert!(evaluate(&req("sqrt", -1.0, 0.0, "")).is_err());
        assert_eq!(evaluate(&req("sqrt", 9.0, 0.0, "")).unwrap(), json!(3.0));
    }

    #[test]
    fn sha1_matches_known_vector() {
        // sha1("abc") == a9993e364706816aba3e25717850c26c9cd0d89d
        assert_eq!(
            evaluate(&req("sha1", 0.0, 0.0, "abc")).unwrap(),
            json!("a9993e364706816aba3e25717850c26c9cd0d89d")
        );
    }

    #[test]
    fn reverse_is_unicode_aware() {
        assert_eq!(
            evaluate(&req("reverse", 0.0, 0.0, "爪哇你好")).unwrap(),
            json!("好你哇爪")
        );
    }

    #[test]
    fn wordcount_splits_on_whitespace() {
        assert_eq!(
            evaluate(&req("wordcount", 0.0, 0.0, "  a b\tc\nd ")).unwrap(),
            json!(4)
        );
        assert_eq!(evaluate(&req("wordcount", 0.0, 0.0, "")).unwrap(), json!(0));
    }

    #[test]
    fn prime_and_fib() {
        assert_eq!(evaluate(&req("prime", 97.0, 0.0, "")).unwrap(), json!(true));
        assert_eq!(evaluate(&req("prime", 91.0, 0.0, "")).unwrap(), json!(false));
        assert!(evaluate(&req("prime", -3.0, 0.0, "")).is_err());
        assert_eq!(evaluate(&req("fib", 10.0, 0.0, "")).unwrap(), json!(55));
        assert!(evaluate(&req("fib", 91.0, 0.0, "")).is_err());
    }

    #[test]
    fn unknown_op_is_rejected() {
        let err = evaluate(&req("nope", 0.0, 0.0, "")).unwrap_err();
        assert!(err.contains("unknown op"));
    }

    #[test]
    fn counter_default_delta_is_one() {
        assert_eq!(default_delta(), 1);
        // No body at all -> still +1, per contract 2.5.
        assert!(parse_body::<CounterRequest>(b"").unwrap().is_none());
        let parsed: CounterRequest = parse_body(b"{}").unwrap().unwrap();
        assert_eq!(parsed.delta, 1);
        let parsed: CounterRequest = parse_body(b"{\"delta\":-9}").unwrap().unwrap();
        assert_eq!(parsed.delta, -9);
    }

    #[test]
    fn empty_body_is_none_but_malformed_body_is_an_error() {
        // The contract: no body -> empty request. A *broken* body must not be
        // silently treated as empty (that was a real bug: Option<Json<T>> does
        // exactly that).
        assert!(parse_body::<EchoRequest>(b"").unwrap().is_none());
        assert!(parse_body::<EchoRequest>(b"   \n\t ").unwrap().is_none());

        let ok: EchoRequest = parse_body(b"{\"message\":\"hi\"}").unwrap().unwrap();
        assert_eq!(ok.message, "hi");

        assert!(parse_body::<EchoRequest>(b"{\"message\":").is_err());
        assert!(parse_body::<EchoRequest>(b"not json at all").is_err());
    }

    #[test]
    fn sanitize_blocks_traversal() {
        assert!(sanitize_relative("../secret").is_none());
        assert!(sanitize_relative("a/../../secret").is_none());
        assert!(sanitize_relative("C:/Windows").is_none());
        assert!(sanitize_relative("a\\b").is_none());
        assert!(sanitize_relative("").is_none());
        assert_eq!(
            sanitize_relative("/extension/claw-bridge/index.js").unwrap(),
            PathBuf::from("extension/claw-bridge/index.js")
        );
    }
}
