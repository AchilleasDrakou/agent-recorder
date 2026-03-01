#!/usr/bin/env node
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
import { spawn } from "child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(HERE, "..");

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).length > 0) return value;
  }
  return undefined;
}

function boolArg(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const v = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean value \"${value}\"`);
}

function parseIntegerArg(name, rawValue, { min, max }) {
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got ${rawValue}`);
  }
  return parsed;
}

function parseRateFraction(rate) {
  if (!rate || !String(rate).includes("/")) return null;
  const [nRaw, dRaw] = String(rate).split("/");
  const n = Number(nRaw);
  const d = Number(dRaw);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

function runChild(cmd, args, { cwd = REPO_DIR, stdio = "inherit", capture = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : stdio,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(new Error(`${cmd} exited with code=${code ?? "null"} signal=${signal ?? "none"} ${stderr}`.trim()));
    });
  });
}

async function probeVideo(output, ffprobeBin = "ffprobe") {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate,nb_frames:format=duration,size",
    "-of", "default=noprint_wrappers=1",
    output,
  ];
  try {
    const { stdout } = await runChild(ffprobeBin, args, { capture: true });
    const metrics = {};
    for (const line of String(stdout).split(/\r?\n/)) {
      const [k, ...rest] = line.split("=");
      if (!k || rest.length === 0) continue;
      metrics[k.trim()] = rest.join("=").trim();
    }
    const fps = parseRateFraction(metrics.avg_frame_rate);
    if (fps !== null) metrics.effective_fps = fps.toFixed(3);
    return metrics;
  } catch {
    return { probe_error: true };
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      output: { type: "string" },
      mode: { type: "string" },
      name: { type: "string" },
      duration: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      fps: { type: "string" },
      chrome: { type: "string" },
      ffmpeg: { type: "string" },
      ffprobe: { type: "string" },
      encoder: { type: "string" },
      "video-bitrate": { type: "string" },
      maxrate: { type: "string" },
      bufsize: { type: "string" },
      "jpeg-quality": { type: "string" },
      "ws-endpoint": { type: "string" },
      build: { type: "string", default: "false" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage:
  node scripts/agent-capture.mjs --url <url> --output <file.mp4> [options]
`);
    return;
  }

  const url = pick(values.url);
  if (!url) throw new Error("Missing URL");
  const output = resolve(String(pick(values.output, "./recording.mp4")));
  await mkdir(dirname(output), { recursive: true });

  const mode = String(pick(values.mode, "after")).toLowerCase() === "before" ? "before" : "after";
  const name = String(pick(values.name, "proof"));

  const duration = parseIntegerArg("duration", pick(values.duration, "8"), { min: 1, max: 7200 });
  const width = parseIntegerArg("width", pick(values.width, "1280"), { min: 16, max: 7680 });
  const height = parseIntegerArg("height", pick(values.height, "720"), { min: 16, max: 4320 });
  const fps = parseIntegerArg("fps", pick(values.fps, "10"), { min: 1, max: 60 });
  const jpegQuality = parseIntegerArg("jpeg-quality", pick(values["jpeg-quality"], "90"), { min: 1, max: 100 });

  const shouldBuild = boolArg(values.build, false);
  const recorderBin = resolve(REPO_DIR, "target/release/agent-recorder");

  if (shouldBuild) {
    await runChild("cargo", ["build", "--release", "-q"], { cwd: REPO_DIR, stdio: "inherit" });
  }

  const recorderArgs = [
    "--url", String(url),
    "--output", output,
    "--duration", String(duration),
    "--width", String(width),
    "--height", String(height),
    "--fps", String(fps),
    "--jpeg-quality", String(jpegQuality),
  ];

  if (values.chrome) recorderArgs.push("--chrome", String(values.chrome));
  if (values.ffmpeg) recorderArgs.push("--ffmpeg", String(values.ffmpeg));
  if (values.encoder) recorderArgs.push("--encoder", String(values.encoder));
  if (values["video-bitrate"]) recorderArgs.push("--video-bitrate", String(values["video-bitrate"]));
  if (values.maxrate) recorderArgs.push("--maxrate", String(values.maxrate));
  if (values.bufsize) recorderArgs.push("--bufsize", String(values.bufsize));
  if (values["ws-endpoint"]) recorderArgs.push("--ws-endpoint", String(values["ws-endpoint"]));

  await runChild(recorderBin, recorderArgs, { cwd: REPO_DIR, stdio: "inherit" });

  const metrics = await probeVideo(output, String(pick(values.ffprobe, "ffprobe")));
  const sidecar = {
    ok: true,
    mode,
    name,
    url,
    output,
    duration,
    width,
    height,
    fps,
    jpegQuality,
    wsEndpoint: pick(values["ws-endpoint"], null),
    metrics,
    createdAt: new Date().toISOString(),
  };

  const sidecarPath = `${output}.proof.json`;
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({ ok: true, mode, output, sidecar: sidecarPath, metrics }, null, 2));
}

main().catch((err) => {
  console.error(`[agent-capture] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
