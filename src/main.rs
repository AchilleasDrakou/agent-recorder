use std::{
    collections::HashSet,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::Engine;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Mutex},
    time::sleep,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[derive(Parser, Debug)]
#[command(name = "agent-recorder")]
struct Args {
    #[arg(long)]
    url: String,
    #[arg(long, default_value = "recording.mp4")]
    output: PathBuf,
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u64).range(1..=7200))]
    duration: u64,
    #[arg(long, default_value_t = 1280, value_parser = clap::value_parser!(u32).range(16..=7680))]
    width: u32,
    #[arg(long, default_value_t = 720, value_parser = clap::value_parser!(u32).range(16..=4320))]
    height: u32,
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u32).range(1..=60))]
    fps: u32,
    #[arg(long, default_value_t = 90, value_parser = clap::value_parser!(u32).range(1..=100))]
    jpeg_quality: u32,
    #[arg(long)]
    script: Option<PathBuf>,
    #[arg(long, default_value = "/usr/bin/chromium")]
    chrome: String,
    #[arg(long, default_value = "ffmpeg")]
    ffmpeg: String,
    #[arg(long, default_value = "auto")]
    encoder: String,
    #[arg(long)]
    video_bitrate: Option<String>,
    #[arg(long)]
    maxrate: Option<String>,
    #[arg(long)]
    bufsize: Option<String>,
    #[arg(long, default_value = "/dev/dri/renderD128")]
    vaapi_device: String,
    #[arg(long)]
    ws_endpoint: Option<String>,
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = futures_util::stream::SplitSink<WsStream, Message>;

struct CdpClient {
    sink: Arc<Mutex<WsSink>>,
    next_id: Arc<AtomicU64>,
}

struct ChromeLaunch {
    child: Child,
    ws_endpoint: String,
    profile_dir: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VideoEncoder {
    Libx264,
    H264VideoToolbox,
    H264Nvenc,
    H264Vaapi,
    H264Qsv,
}

impl VideoEncoder {
    fn as_ffmpeg_name(self) -> &'static str {
        match self {
            VideoEncoder::Libx264 => "libx264",
            VideoEncoder::H264VideoToolbox => "h264_videotoolbox",
            VideoEncoder::H264Nvenc => "h264_nvenc",
            VideoEncoder::H264Vaapi => "h264_vaapi",
            VideoEncoder::H264Qsv => "h264_qsv",
        }
    }
}

impl CdpClient {
    async fn connect(
        endpoint: &str,
        frame_tx: mpsc::Sender<(String, u64)>,
    ) -> Result<Self, String> {
        let (ws, _) = tokio::time::timeout(Duration::from_secs(10), connect_async(endpoint))
            .await
            .map_err(|_| format!("Timed out connecting to CDP endpoint {endpoint}"))?
            .map_err(|e| e.to_string())?;
        let (sink, mut stream) = ws.split();
        let sink = Arc::new(Mutex::new(sink));

        tokio::spawn(async move {
            while let Some(msg) = stream.next().await {
                let Ok(msg) = msg else { break };
                let Message::Text(text) = msg else { continue };
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };

                if let Some(err) = v.get("error") {
                    eprintln!("[cdp] error response: {}", err);
                } else if std::env::var_os("AGENT_RECORDER_DEBUG_CDP").is_some()
                    && v.get("id").is_some()
                {
                    eprintln!("[cdp] response: {}", v);
                }

                if v.get("method").and_then(Value::as_str) == Some("Page.screencastFrame") {
                    let Some(params) = v.get("params") else {
                        continue;
                    };
                    let Some(data) = params.get("data").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(session_id) = params.get("sessionId").and_then(Value::as_u64) else {
                        continue;
                    };
                    let _ = frame_tx.send((data.to_string(), session_id)).await;
                }
            }
        });

        Ok(Self {
            sink,
            next_id: Arc::new(AtomicU64::new(1)),
        })
    }

    async fn send(&self, method: &str, params: Value) -> Result<(), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        tokio::time::timeout(Duration::from_secs(5), async {
            self.sink
                .lock()
                .await
                .send(Message::Text(
                    json!({"id": id, "method": method, "params": params}).to_string(),
                ))
                .await
        })
        .await
        .map_err(|_| format!("Timed out sending CDP method {method}"))?
        .map_err(|e| e.to_string())
    }
}

fn parse_bitrate_to_kbps(input: &str) -> Option<u64> {
    let trimmed = input.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    let unit = trimmed.chars().last()?;
    if unit.is_ascii_digit() {
        return trimmed.parse::<u64>().ok();
    }
    let number = trimmed[..trimmed.len() - 1].parse::<u64>().ok()?;
    match unit {
        'k' => Some(number),
        'm' => Some(number * 1000),
        'g' => Some(number * 1000 * 1000),
        _ => None,
    }
}

fn format_kbps(value: u64) -> String {
    format!("{}k", value.max(1))
}

fn default_bitrate_kbps(width: u32, height: u32, fps: u32) -> u64 {
    let pixels_per_second = u64::from(width) * u64::from(height) * u64::from(fps.max(1));
    if pixels_per_second <= 3_000_000 {
        1200
    } else if pixels_per_second <= 14_000_000 {
        3000
    } else if pixels_per_second <= 40_000_000 {
        8000
    } else {
        12000
    }
}

fn resolve_rate_control(args: &Args) -> (String, String, String) {
    let bitrate = args
        .video_bitrate
        .clone()
        .unwrap_or_else(|| format_kbps(default_bitrate_kbps(args.width, args.height, args.fps)));

    if let Some(parsed) = parse_bitrate_to_kbps(&bitrate) {
        let maxrate = args
            .maxrate
            .clone()
            .unwrap_or_else(|| format_kbps(parsed * 3 / 2));
        let bufsize = args
            .bufsize
            .clone()
            .unwrap_or_else(|| format_kbps(parsed * 2));
        (bitrate, maxrate, bufsize)
    } else {
        (
            bitrate.clone(),
            args.maxrate.clone().unwrap_or_else(|| bitrate.clone()),
            args.bufsize.clone().unwrap_or(bitrate),
        )
    }
}

async fn read_ffmpeg_encoder_list(ffmpeg_bin: &str) -> Result<HashSet<String>, String> {
    let output = Command::new(ffmpeg_bin)
        .args(["-hide_banner", "-encoders"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed querying ffmpeg encoders: {e}"))?;

    let mut set = HashSet::new();
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    for line in combined.lines() {
        if line.starts_with(' ') {
            let mut parts = line.split_whitespace();
            let _flags = parts.next();
            if let Some(name) = parts.next() {
                set.insert(name.to_ascii_lowercase());
            }
        }
    }

    Ok(set)
}

async fn resolve_video_encoder(args: &Args) -> Result<VideoEncoder, String> {
    let requested = args.encoder.trim().to_ascii_lowercase();
    let supported = read_ffmpeg_encoder_list(&args.ffmpeg)
        .await
        .unwrap_or_default();

    let to_encoder = |name: &str| match name {
        "libx264" => Some(VideoEncoder::Libx264),
        "h264_videotoolbox" => Some(VideoEncoder::H264VideoToolbox),
        "h264_nvenc" => Some(VideoEncoder::H264Nvenc),
        "h264_vaapi" => Some(VideoEncoder::H264Vaapi),
        "h264_qsv" => Some(VideoEncoder::H264Qsv),
        _ => None,
    };

    let is_available = |name: &str| name == "libx264" || supported.contains(name);

    if requested != "auto" {
        let encoder = to_encoder(&requested).ok_or_else(|| {
            "Unsupported --encoder value. Use auto, libx264, h264_videotoolbox, h264_nvenc, h264_vaapi, or h264_qsv".to_string()
        })?;
        if !is_available(encoder.as_ffmpeg_name()) {
            return Err(format!(
                "Requested encoder '{}' is not available in ffmpeg",
                encoder.as_ffmpeg_name()
            ));
        }
        return Ok(encoder);
    }

    #[cfg(target_os = "macos")]
    let auto_order = ["h264_videotoolbox", "libx264"];
    #[cfg(target_os = "linux")]
    let auto_order = ["h264_nvenc", "h264_vaapi", "h264_qsv", "libx264"];
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let auto_order = ["libx264"];

    for name in auto_order {
        if is_available(name) {
            if let Some(encoder) = to_encoder(name) {
                if encoder == VideoEncoder::H264Vaapi
                    && !std::path::Path::new(&args.vaapi_device).exists()
                {
                    continue;
                }
                return Ok(encoder);
            }
        }
    }

    Ok(VideoEncoder::Libx264)
}

async fn spawn_ffmpeg_process(
    ffmpeg_bin: &str,
    ffmpeg_args: &[String],
) -> Result<(Child, ChildStdin), String> {
    let mut ffmpeg = Command::new(ffmpeg_bin)
        .args(ffmpeg_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch ffmpeg: {e}"))?;

    let ffmpeg_stderr = ffmpeg.stderr.take().ok_or("Missing ffmpeg stderr")?;
    tokio::spawn(async move {
        let mut reader = BufReader::new(ffmpeg_stderr);
        let mut buf = String::new();
        while reader
            .read_line(&mut buf)
            .await
            .ok()
            .filter(|n| *n > 0)
            .is_some()
        {
            if buf.to_lowercase().contains("error") {
                eprintln!("[ffmpeg] {}", buf.trim());
            }
            buf.clear();
        }
    });

    let ffmpeg_in = ffmpeg.stdin.take().ok_or("Missing ffmpeg stdin")?;
    Ok((ffmpeg, ffmpeg_in))
}

fn build_ffmpeg_args(
    args: &Args,
    encoder: VideoEncoder,
    bitrate: &str,
    maxrate: &str,
    bufsize: &str,
) -> Result<Vec<String>, String> {
    let mut ffmpeg_args = vec![
        "-y".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-framerate".to_string(),
        args.fps.to_string(),
        "-i".to_string(),
        "-".to_string(),
    ];

    append_encoder_ffmpeg_args(&mut ffmpeg_args, args, encoder, bitrate, maxrate, bufsize);

    ffmpeg_args.extend([
        "-movflags".to_string(),
        "+faststart".to_string(),
        args.output
            .to_str()
            .ok_or("Invalid output path")?
            .to_string(),
    ]);

    Ok(ffmpeg_args)
}

fn append_encoder_ffmpeg_args(
    ffmpeg_args: &mut Vec<String>,
    args: &Args,
    encoder: VideoEncoder,
    bitrate: &str,
    maxrate: &str,
    bufsize: &str,
) {
    let gop = (args.fps.max(1) * 2).to_string();
    match encoder {
        VideoEncoder::Libx264 => {
            ffmpeg_args.extend([
                "-c:v".to_string(),
                "libx264".to_string(),
                "-preset".to_string(),
                "fast".to_string(),
                "-crf".to_string(),
                "21".to_string(),
                "-g".to_string(),
                gop,
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        VideoEncoder::H264VideoToolbox => {
            ffmpeg_args.extend([
                "-c:v".to_string(),
                "h264_videotoolbox".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
                "-realtime".to_string(),
                "true".to_string(),
                "-b:v".to_string(),
                bitrate.to_string(),
                "-maxrate".to_string(),
                maxrate.to_string(),
                "-bufsize".to_string(),
                bufsize.to_string(),
                "-g".to_string(),
                gop,
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        VideoEncoder::H264Nvenc => {
            ffmpeg_args.extend([
                "-c:v".to_string(),
                "h264_nvenc".to_string(),
                "-preset".to_string(),
                "p5".to_string(),
                "-b:v".to_string(),
                bitrate.to_string(),
                "-maxrate".to_string(),
                maxrate.to_string(),
                "-bufsize".to_string(),
                bufsize.to_string(),
                "-g".to_string(),
                gop,
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        VideoEncoder::H264Vaapi => {
            ffmpeg_args.extend([
                "-vaapi_device".to_string(),
                args.vaapi_device.clone(),
                "-vf".to_string(),
                "format=nv12,hwupload".to_string(),
                "-c:v".to_string(),
                "h264_vaapi".to_string(),
                "-profile:v".to_string(),
                "high".to_string(),
                "-b:v".to_string(),
                bitrate.to_string(),
                "-maxrate".to_string(),
                maxrate.to_string(),
                "-bufsize".to_string(),
                bufsize.to_string(),
                "-g".to_string(),
                gop,
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
        VideoEncoder::H264Qsv => {
            ffmpeg_args.extend([
                "-c:v".to_string(),
                "h264_qsv".to_string(),
                "-b:v".to_string(),
                bitrate.to_string(),
                "-maxrate".to_string(),
                maxrate.to_string(),
                "-bufsize".to_string(),
                bufsize.to_string(),
                "-g".to_string(),
                gop,
                "-pix_fmt".to_string(),
                "yuv420p".to_string(),
            ]);
        }
    }
}

fn make_chrome_profile_dir() -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Failed to read system clock: {e}"))?
        .as_millis();
    let dir = std::env::temp_dir().join(format!(
        "agent-recorder-chrome-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create chrome profile dir {}: {e}", dir.display()))?;
    Ok(dir)
}

async fn http_get_json(port: u16, path: &str) -> Result<Value, String> {
    let mut stream = tokio::time::timeout(
        Duration::from_secs(2),
        TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .map_err(|_| format!("Timed out connecting to chrome devtools HTTP on {port}"))?
    .map_err(|e| format!("Failed connecting to chrome devtools HTTP on {port}: {e}"))?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    tokio::time::timeout(Duration::from_secs(2), stream.write_all(req.as_bytes()))
        .await
        .map_err(|_| "Timed out writing devtools HTTP request".to_string())?
        .map_err(|e| format!("Failed writing devtools HTTP request: {e}"))?;

    let mut buf = Vec::new();
    let mut header_end = None;
    let mut content_length: Option<usize> = None;

    loop {
        let mut chunk = [0_u8; 4096];
        let bytes_read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut chunk))
            .await
            .map_err(|_| "Timed out reading devtools HTTP response".to_string())?
            .map_err(|e| format!("Failed reading devtools HTTP response: {e}"))?;
        if bytes_read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..bytes_read]);

        if header_end.is_none() {
            if let Some(idx) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let end = idx + 4;
                header_end = Some(end);

                let headers = std::str::from_utf8(&buf[..idx])
                    .map_err(|e| format!("Invalid devtools HTTP headers: {e}"))?;
                for line in headers.lines().skip(1) {
                    if let Some((name, value)) = line.split_once(':') {
                        if name.trim().eq_ignore_ascii_case("content-length") {
                            if let Ok(len) = value.trim().parse::<usize>() {
                                content_length = Some(len);
                            }
                        }
                    }
                }
            }
        }

        if let Some(end) = header_end {
            if let Some(len) = content_length {
                if buf.len() >= end + len {
                    break;
                }
            }
        }
    }

    let end = match header_end {
        Some(end) => end,
        None => {
            let body_start = buf
                .iter()
                .position(|b| !b.is_ascii_whitespace())
                .unwrap_or(0);
            let body_bytes = &buf[body_start..];
            if !body_bytes.is_empty() && (body_bytes[0] == b'{' || body_bytes[0] == b'[') {
                return serde_json::from_slice(body_bytes)
                    .map_err(|e| format!("Invalid headerless devtools JSON payload: {e}"));
            }
            let sample = String::from_utf8_lossy(&buf[..buf.len().min(120)]);
            return Err(format!("Malformed devtools HTTP response: '{}'", sample));
        }
    };
    let headers = std::str::from_utf8(&buf[..end - 4])
        .map_err(|e| format!("Invalid devtools HTTP headers: {e}"))?;
    if !headers.starts_with("HTTP/1.1 200") && !headers.starts_with("HTTP/1.0 200") {
        return Err(format!(
            "Unexpected devtools HTTP status: {}",
            headers.lines().next().unwrap_or("<missing status line>")
        ));
    }

    let body_bytes = if let Some(len) = content_length {
        if buf.len() < end + len {
            return Err("Incomplete devtools HTTP body".to_string());
        }
        &buf[end..end + len]
    } else {
        &buf[end..]
    };
    let body = std::str::from_utf8(body_bytes)
        .map_err(|e| format!("Invalid devtools HTTP body encoding: {e}"))?;

    serde_json::from_str(body).map_err(|e| format!("Invalid devtools JSON payload: {e}"))
}

fn extract_page_ws_endpoint(payload: &Value) -> Option<String> {
    let Value::Array(targets) = payload else {
        return None;
    };
    targets.iter().find_map(|target| {
        let target_type = target.get("type").and_then(Value::as_str)?;
        if target_type != "page" {
            return None;
        }
        target
            .get("webSocketDebuggerUrl")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

async fn wait_for_page_ws_endpoint(
    child: &mut Child,
    debug_port: u16,
    timeout: Duration,
) -> Result<String, String> {
    let start = tokio::time::Instant::now();
    let mut last_err: String;

    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed checking chrome status: {e}"))?
        {
            return Err(format!(
                "Chrome exited before page websocket was ready ({status})"
            ));
        }

        last_err = match http_get_json(debug_port, "/json/list").await {
            Ok(payload) => {
                if let Some(page_ws) = extract_page_ws_endpoint(&payload) {
                    return Ok(page_ws);
                }
                "No page target with webSocketDebuggerUrl yet".to_string()
            }
            Err(err) => err,
        };

        if start.elapsed() >= timeout {
            return Err(format!(
                "Timed out waiting for page websocket endpoint on debug port {debug_port}. Last error: {}",
                last_err
            ));
        }

        sleep(Duration::from_millis(40)).await;
    }
}

async fn launch_chrome_with_headless(
    args: &Args,
    headless_flag: &str,
    debug_port: u16,
) -> Result<ChromeLaunch, String> {
    let profile_dir = make_chrome_profile_dir()?;
    let mut cmd = Command::new(&args.chrome);
    cmd.args([headless_flag, "--disable-gpu", "--no-sandbox"]);
    if cfg!(target_os = "linux") {
        cmd.arg("--disable-dev-shm-usage");
    }
    cmd.args([
        &format!("--remote-debugging-port={debug_port}"),
        &format!("--user-data-dir={}", profile_dir.display()),
        "about:blank",
    ]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch chrome: {e}"))?;

    match wait_for_page_ws_endpoint(&mut child, debug_port, Duration::from_secs(35)).await {
        Ok(ws_endpoint) => Ok(ChromeLaunch {
            child,
            ws_endpoint,
            profile_dir,
        }),
        Err(err) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = tokio::fs::remove_dir_all(&profile_dir).await;
            Err(err)
        }
    }
}

async fn launch_chrome(args: &Args) -> Result<ChromeLaunch, String> {
    let mut errors = Vec::new();

    for headless_flag in ["--headless=new", "--headless"] {
        for debug_port in [9222_u16, 9223_u16, 9224_u16] {
            match launch_chrome_with_headless(args, headless_flag, debug_port).await {
                Ok(launch) => return Ok(launch),
                Err(err) => errors.push(format!("{headless_flag} port {debug_port}: {err}")),
            }
        }
    }

    Err(format!(
        "Failed to launch chrome with usable DevTools endpoint. {}",
        errors.join(" | ")
    ))
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("[recorder] {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let args = Args::parse();
    let encoder = resolve_video_encoder(&args).await?;
    let (bitrate, maxrate, bufsize) = resolve_rate_control(&args);

    println!(
        "Recording {} → {} ({}x{}, {}s, {}fps, {})",
        args.url,
        args.output.display(),
        args.width,
        args.height,
        args.duration,
        args.fps,
        encoder.as_ffmpeg_name(),
    );

    let (mut chrome_child, ws_endpoint, mut chrome_profile_dir) =
        if let Some(endpoint) = &args.ws_endpoint {
            (None, endpoint.clone(), None)
        } else {
            let launch = launch_chrome(&args).await?;
            (
                Some(launch.child),
                launch.ws_endpoint,
                Some(launch.profile_dir),
            )
        };

    let result = async {
        let mut active_encoder = encoder;
        let mut ffmpeg_args =
            build_ffmpeg_args(&args, active_encoder, &bitrate, &maxrate, &bufsize)?;
        if std::env::var_os("AGENT_RECORDER_DEBUG_FFMPEG").is_some() {
            eprintln!("[recorder] ffmpeg args: {:?}", ffmpeg_args);
        }
        let (mut ffmpeg, mut ffmpeg_in) = spawn_ffmpeg_process(&args.ffmpeg, &ffmpeg_args).await?;
        let mut did_encoder_fallback = false;
        let (frame_tx, mut frame_rx) = mpsc::channel::<(String, u64)>(200);
        let cdp = CdpClient::connect(&ws_endpoint, frame_tx).await?;

        cdp.send("Page.enable", json!({})).await?;
        cdp.send("Runtime.enable", json!({})).await?;
        cdp.send(
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": args.width,
                "height": args.height,
                "deviceScaleFactor": 1,
                "mobile": false
            }),
        )
        .await?;
        cdp.send("Page.navigate", json!({"url": args.url})).await?;

        cdp.send(
            "Page.startScreencast",
            json!({
                "format": "jpeg",
                "quality": args.jpeg_quality,
                "maxWidth": args.width,
                "maxHeight": args.height,
                "everyNthFrame": 1
            }),
        )
        .await?;

        if let Some(script_path) = &args.script {
            let script = tokio::fs::read_to_string(script_path)
                .await
                .map_err(|e| format!("Failed reading --script file: {e}"))?;
            let _ = cdp
                .send(
                    "Runtime.evaluate",
                    json!({
                        "expression": script,
                        "awaitPromise": false,
                        "userGesture": true,
                        "allowUnsafeEvalBlockedByCSP": true
                    }),
                )
                .await;
        }

        let repaint_expr = "document.body && (document.body.style.opacity = document.body.style.opacity === '0.999' ? '1' : '0.999')";
        let interval = Duration::from_millis((1000 / args.fps.max(1)) as u64);
        let mut ticks = tokio::time::interval(interval);
        let end_at = tokio::time::Instant::now() + Duration::from_secs(args.duration);

        let mut frame_count: u64 = 0;
        while tokio::time::Instant::now() < end_at {
            tokio::select! {
                _ = ticks.tick() => {
                    let _ = cdp.send(
                        "Runtime.evaluate",
                        json!({
                            "expression": repaint_expr,
                            "awaitPromise": false,
                            "allowUnsafeEvalBlockedByCSP": true
                        }),
                    ).await;
                }
                Some((frame_base64, session_id)) = frame_rx.recv() => {
                    frame_count += 1;
                    let frame = base64::engine::general_purpose::STANDARD
                        .decode(frame_base64)
                        .map_err(|e| format!("Invalid frame payload: {e}"))?;
                    if let Err(err) = ffmpeg_in.write_all(&frame).await {
                        let can_fallback = args.encoder.trim().eq_ignore_ascii_case("auto")
                            && !did_encoder_fallback
                            && active_encoder != VideoEncoder::Libx264;
                        if !can_fallback {
                            return Err(format!("Failed writing frame to ffmpeg: {err}"));
                        }

                        eprintln!(
                            "[recorder] Encoder '{}' failed at runtime ({}). Falling back to libx264.",
                            active_encoder.as_ffmpeg_name(),
                            err
                        );
                        did_encoder_fallback = true;
                        active_encoder = VideoEncoder::Libx264;
                        let _ = ffmpeg.kill().await;
                        let _ = ffmpeg.wait().await;
                        ffmpeg_args = build_ffmpeg_args(
                            &args,
                            active_encoder,
                            &bitrate,
                            &maxrate,
                            &bufsize,
                        )?;
                        if std::env::var_os("AGENT_RECORDER_DEBUG_FFMPEG").is_some() {
                            eprintln!("[recorder] fallback ffmpeg args: {:?}", ffmpeg_args);
                        }
                        let spawned = spawn_ffmpeg_process(&args.ffmpeg, &ffmpeg_args).await?;
                        ffmpeg = spawned.0;
                        ffmpeg_in = spawned.1;
                        ffmpeg_in
                            .write_all(&frame)
                            .await
                            .map_err(|e| format!("Failed writing frame after fallback: {e}"))?;
                    }
                    let _ = cdp.send("Page.screencastFrameAck", json!({"sessionId": session_id})).await;
                }
            }
        }

        let _ = cdp.send("Page.stopScreencast", json!({})).await;
        drop(ffmpeg_in);

        let status = ffmpeg
            .wait();
        let status = tokio::time::timeout(Duration::from_secs(args.duration + 8), status)
            .await
            .map_err(|_| "Timed out waiting for ffmpeg to finish".to_string())?
            .map_err(|e| format!("Failed waiting for ffmpeg: {e}"))?;
        if !status.success() {
            return Err(format!("FFmpeg exited with {status}"));
        }

        println!("Captured {frame_count} frames");
        println!("✓ Saved to {}", args.output.display());
        Ok(())
    }
    .await;

    if let Some(child) = chrome_child.as_mut() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    if let Some(profile_dir) = chrome_profile_dir.take() {
        let _ = tokio::fs::remove_dir_all(profile_dir).await;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::extract_page_ws_endpoint;
    use serde_json::json;

    #[test]
    fn extracts_page_ws_endpoint_from_json_list() {
        let payload = json!([
            {"type": "service_worker", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/sw/1"},
            {"type": "page", "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/2"}
        ]);
        let endpoint = extract_page_ws_endpoint(&payload).expect("page endpoint should exist");
        assert_eq!(endpoint, "ws://127.0.0.1:9222/devtools/page/2");
    }

    #[test]
    fn rejects_non_array_or_missing_page_target() {
        assert!(extract_page_ws_endpoint(&json!({"type": "page"})).is_none());
        assert!(extract_page_ws_endpoint(&json!([{"type": "service_worker"}])).is_none());
    }
}
