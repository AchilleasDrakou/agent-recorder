#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { spawn } from "child_process";
import { parseArgs } from "util";

function parseIntegerArg(name, rawValue, { min, max }) {
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}. Received "${rawValue}".`);
  }
  return parsed;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function runCommand(cmd, args, { stdio = "inherit", cwd = process.cwd() } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio, cwd });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${cmd} exited with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

function runCapture(cmd, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      rejectRun(new Error(`${cmd} exited with code=${code ?? "null"} signal=${signal ?? "none"}: ${stderr.trim()}`));
    });
  });
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

async function loadSpec(specPath) {
  if (!specPath) return {};
  const content = await readFile(specPath, "utf8");
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--spec must be a JSON object");
  }
  return parsed;
}

function boolArg(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  const v = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "y"].includes(v)) return true;
  if (["0", "false", "no", "n"].includes(v)) return false;
  throw new Error(`Invalid boolean value "${value}"`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      url: { type: "string" },
      mode: { type: "string" }, // before|after
      name: { type: "string" },
      goal: { type: "string" },
      output: { type: "string" },
      "out-dir": { type: "string", default: "./proofs" },
      duration: { type: "string" },
      width: { type: "string" },
      height: { type: "string" },
      fps: { type: "string" },
      chrome: { type: "string" },
      ffmpeg: { type: "string" },
      script: { type: "string" },
      encoder: { type: "string" },
      "video-bitrate": { type: "string" },
      maxrate: { type: "string" },
      bufsize: { type: "string" },
      "jpeg-quality": { type: "string" },
      "ws-endpoint": { type: "string" },
      build: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage:
  node scripts/agent-proof.mjs --url <url> --mode before|after --name <slug>
  node scripts/agent-proof.mjs --spec ./proof-spec.json

Writes:
  - video file (.mp4)
  - sidecar metadata (<output>.proof.json)
`);
    return;
  }

  const spec = await loadSpec(values.spec);
  const modeRaw = pick(values.mode, spec.mode, "after");
  const mode = String(modeRaw).toLowerCase();
  if (!["before", "after"].includes(mode)) {
    throw new Error(`mode must be "before" or "after", got "${modeRaw}"`);
  }

  const url = pick(values.url, spec.url);
  if (!url) throw new Error("Missing URL. Pass --url or set spec.url.");

  const name = String(pick(values.name, spec.name, "proof")).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const goal = pick(values.goal, spec.goal, "");
  const assertions = Array.isArray(spec.assertions) ? spec.assertions : [];
  const outDir = resolve(String(pick(values["out-dir"], spec.outDir, "./proofs")));

  const duration = parseIntegerArg("duration", pick(values.duration, spec.duration, "8"), { min: 1, max: 7200 });
  const width = parseIntegerArg("width", pick(values.width, spec.width, "1280"), { min: 16, max: 7680 });
  const height = parseIntegerArg("height", pick(values.height, spec.height, "720"), { min: 16, max: 4320 });
  const fps = parseIntegerArg("fps", pick(values.fps, spec.fps, "10"), { min: 1, max: 60 });
  const jpegQuality = parseIntegerArg("jpeg-quality", pick(values["jpeg-quality"], spec.jpegQuality, "90"), { min: 1, max: 100 });
  const shouldBuild = boolArg(pick(values.build, spec.build), true);

  await mkdir(outDir, { recursive: true });
  const output = resolve(
    String(
      pick(
        values.output,
        spec.output,
        `${outDir}/${mode}-${name}-${nowStamp()}.mp4`,
      ),
    ),
  );
  await mkdir(dirname(output), { recursive: true });

  const rustBin = resolve("./target/debug/agent-recorder");
  if (shouldBuild) {
    await runCommand("cargo", ["build", "-q"]);
  } else {
    await stat(rustBin);
  }

  const recorderArgs = [
    "--url", String(url),
    "--output", output,
    "--duration", String(duration),
    "--width", String(width),
    "--height", String(height),
    "--fps", String(fps),
    "--ffmpeg", String(pick(values.ffmpeg, spec.ffmpeg, "ffmpeg")),
    "--encoder", String(pick(values.encoder, spec.encoder, "auto")),
    "--jpeg-quality", String(jpegQuality),
  ];

  const optionalPairs = [
    ["--chrome", pick(values.chrome, spec.chrome)],
    ["--script", pick(values.script, spec.script)],
    ["--video-bitrate", pick(values["video-bitrate"], spec.videoBitrate)],
    ["--maxrate", pick(values.maxrate, spec.maxrate)],
    ["--bufsize", pick(values.bufsize, spec.bufsize)],
    ["--ws-endpoint", pick(values["ws-endpoint"], spec.wsEndpoint)],
  ];
  for (const [flag, val] of optionalPairs) {
    if (val !== undefined && val !== null && String(val).trim() !== "") {
      recorderArgs.push(flag, String(val));
    }
  }

  await runCommand(rustBin, recorderArgs, { stdio: "inherit" });

  const { stdout: probeStdout } = await runCapture("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-show_entries", "stream=avg_frame_rate,nb_frames",
    "-of", "default=noprint_wrappers=1",
    output,
  ]);

  const metrics = {};
  for (const line of probeStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    metrics[key] = rest.join("=");
  }

  const sidecarPath = `${output}.proof.json`;
  const payload = {
    mode,
    name,
    url,
    goal,
    assertions,
    output,
    metrics,
    command: [rustBin, ...recorderArgs].join(" "),
    recordedAt: new Date().toISOString(),
  };
  await writeFile(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    mode,
    output,
    sidecar: sidecarPath,
    metrics,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[agent-proof] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
