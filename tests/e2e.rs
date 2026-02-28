use std::{fs, io::Write, net::SocketAddr, process::Stdio, time::Duration};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tempfile::tempdir;
use tokio::net::TcpListener;
use tokio::process::Command;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn records_video_with_mock_cdp_and_fake_ffmpeg() {
    let dir = tempdir().unwrap();
    let output = dir.path().join("out.mp4");
    let ffmpeg = dir.path().join("fake-ffmpeg.sh");

    let mut file = fs::File::create(&ffmpeg).unwrap();
    writeln!(file, "#!/usr/bin/env bash").unwrap();
    writeln!(file, "set -euo pipefail").unwrap();
    writeln!(file, "out=\"${{@: -1}}\"").unwrap();
    writeln!(file, "cat > \"$out\"").unwrap();
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&ffmpeg).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ffmpeg, perms).unwrap();
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let ws_url = format!("ws://{addr}");

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(stream).await.unwrap();
        let jpeg = base64::engine::general_purpose::STANDARD.encode([0xFF, 0xD8, 0xFF, 0xD9]);
        let mut started = false;
        let mut stop_seen = false;

        while let Some(msg) = ws.next().await {
            let Ok(msg) = msg else {
                break;
            };
            let Message::Text(text) = msg else {
                continue;
            };

            let v: Value = serde_json::from_str(&text).unwrap();
            let Some(id) = v.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let Some(method) = v.get("method").and_then(Value::as_str) else {
                continue;
            };

            ws.send(Message::Text(json!({"id": id, "result": {}}).to_string()))
                .await
                .unwrap();

            if method == "Page.startScreencast" && !started {
                started = true;
                for i in 1..=3u64 {
                    ws.send(Message::Text(
                        json!({
                            "method": "Page.screencastFrame",
                            "params": {"data": jpeg, "sessionId": i}
                        })
                        .to_string(),
                    ))
                    .await
                    .unwrap();
                }
            }

            if method == "Page.stopScreencast" {
                stop_seen = true;
                break;
            }
        }

        stop_seen
    });

    let mut bin = std::env::current_exe().unwrap();
    bin.pop();
    if bin.ends_with("deps") {
        bin.pop();
    }
    bin.push(format!("agent-recorder{}", std::env::consts::EXE_SUFFIX));

    let child = Command::new(bin)
        .args([
            "--url",
            "http://example.test",
            "--output",
            output.to_str().unwrap(),
            "--duration",
            "1",
            "--fps",
            "2",
            "--ws-endpoint",
            &ws_url,
            "--ffmpeg",
            ffmpeg.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let output_res = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .expect("recorder process timed out")
        .unwrap();
    assert!(
        output_res.status.success(),
        "recorder exited with {}\nstdout:\n{}\nstderr:\n{}",
        output_res.status,
        String::from_utf8_lossy(&output_res.stdout),
        String::from_utf8_lossy(&output_res.stderr)
    );

    let stop_seen = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("mock CDP server timed out")
        .unwrap();
    assert!(
        stop_seen,
        "mock CDP server never received Page.stopScreencast"
    );

    let bytes = fs::read(&output).unwrap();
    assert!(!bytes.is_empty());
}
