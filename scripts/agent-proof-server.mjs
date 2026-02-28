#!/usr/bin/env node
import { createServer } from "http";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { parseArgs } from "util";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "8788" },
    "out-dir": { type: "string", default: "./proofs/api" },
  },
});

const host = values.host;
const port = Number.parseInt(values.port, 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid --port "${values.port}"`);
}
const apiToken = process.env.AGENT_PROOF_API_TOKEN || "";

const outDir = resolve(values["out-dir"]);
const runs = new Map();
const queue = [];
let activeRunId = null;
let activeChild = null;

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function nowIso() {
  return new Date().toISOString();
}

function isTerminalStatus(status) {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function getBearerToken(req) {
  const raw = req.headers.authorization;
  if (!raw) return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isAuthorized(req, path) {
  if (!apiToken) return true;
  if (path === "/health") return true;
  return getBearerToken(req) === apiToken;
}

function safeName(value, fallback) {
  const str = String(value ?? fallback ?? "proof");
  const normalized = str.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.length ? normalized : fallback;
}

function summarizeRun(run) {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    mode: run.spec.mode,
    name: run.spec.name,
    url: run.spec.url,
    output: run.spec.output,
    sidecar: `${run.spec.output}.proof.json`,
    error: run.error ?? null,
  };
}

function parseJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        rejectBody(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (err) {
        rejectBody(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on("error", rejectBody);
  });
}

async function runOne(runId) {
  const run = runs.get(runId);
  if (!run) return;
  if (run.status !== "queued") return;
  activeRunId = runId;
  run.status = "running";
  run.startedAt = nowIso();
  run.updatedAt = nowIso();

  const specPath = run.specPath;
  const args = ["./scripts/agent-proof.mjs", "--spec", specPath];

  await new Promise((resolveRun) => {
    const child = spawn("node", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });
    activeChild = child;
    run.pid = child.pid;

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });

    child.once("close", async (code, signal) => {
      run.stdoutTail = stdout.slice(-20_000);
      run.stderrTail = stderr.slice(-20_000);
      run.exitCode = code;
      run.signal = signal;
      run.finishedAt = nowIso();
      run.updatedAt = nowIso();
      run.pid = null;

      if (run.cancelRequested) {
        run.status = "canceled";
        run.error = run.error ?? "Run canceled by user";
      } else if (code === 0) {
        run.status = "succeeded";
        try {
          const sidecarContent = await readFile(`${run.spec.output}.proof.json`, "utf8");
          run.result = JSON.parse(sidecarContent);
        } catch (err) {
          run.error = `Run succeeded but sidecar read failed: ${err.message}`;
        }
      } else {
        run.status = "failed";
        run.error = `agent-proof exited with code=${code ?? "null"} signal=${signal ?? "none"}`;
      }
      activeChild = null;
      resolveRun();
    });

    child.once("error", (err) => {
      if (run.cancelRequested) {
        run.status = "canceled";
        run.error = run.error ?? "Run canceled by user";
      } else {
        run.status = "failed";
        run.error = `Failed spawning agent-proof: ${err.message}`;
      }
      run.finishedAt = nowIso();
      run.updatedAt = nowIso();
      run.pid = null;
      activeChild = null;
      resolveRun();
    });
  });

  activeRunId = null;
}

async function drainQueue() {
  if (activeRunId || queue.length === 0) return;
  const nextId = queue.shift();
  const run = runs.get(nextId);
  if (!run || run.status !== "queued") {
    setImmediate(drainQueue);
    return;
  }
  await runOne(nextId);
  setImmediate(drainQueue);
}

async function createRunFromRequest(requestBody) {
  const baseSpec =
    requestBody && typeof requestBody === "object" && requestBody.spec && typeof requestBody.spec === "object"
      ? requestBody.spec
      : requestBody ?? {};
  const url = baseSpec.url;
  if (!url || String(url).trim() === "") {
    throw new Error("Missing spec.url");
  }

  const id = randomUUID();
  const mode = String(baseSpec.mode ?? "after").toLowerCase() === "before" ? "before" : "after";
  const name = safeName(baseSpec.name, "proof");
  const output =
    baseSpec.output && String(baseSpec.output).trim() !== ""
      ? resolve(String(baseSpec.output))
      : resolve(outDir, `${mode}-${name}-${id}.mp4`);

  const spec = {
    ...baseSpec,
    mode,
    name,
    output,
  };

  const specPath = resolve(outDir, `${id}.spec.json`);
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf8");

  const run = {
    id,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    spec,
    specPath,
    stdoutTail: "",
    stderrTail: "",
    exitCode: null,
    signal: null,
    pid: null,
    cancelRequested: false,
    result: null,
    error: null,
  };

  runs.set(id, run);
  queue.push(id);
  setImmediate(drainQueue);
  return run;
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url || !req.method) {
      sendJson(res, 400, { ok: false, error: "Invalid request" });
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);
    const path = url.pathname;
    if (!isAuthorized(req, path)) {
      sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, {
        ok: true,
        activeRunId,
        queued: queue.length,
        runs: runs.size,
      });
      return;
    }

    if (req.method === "GET" && path === "/proof-runs") {
      const items = Array.from(runs.values()).map(summarizeRun);
      sendJson(res, 200, { ok: true, items });
      return;
    }

    if (req.method === "POST" && path === "/proof-runs") {
      const body = await parseJsonBody(req);
      const run = await createRunFromRequest(body);
      sendJson(res, 202, { ok: true, run: summarizeRun(run) });
      return;
    }

    const match = path.match(/^\/proof-runs\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const id = decodeURIComponent(match[1]);
      const run = runs.get(id);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "Run not found" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        run: summarizeRun(run),
        result: run.result,
        stdoutTail: run.stdoutTail,
        stderrTail: run.stderrTail,
      });
      return;
    }
    if (req.method === "DELETE" && match) {
      const id = decodeURIComponent(match[1]);
      const run = runs.get(id);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "Run not found" });
        return;
      }
      if (isTerminalStatus(run.status)) {
        sendJson(res, 409, { ok: false, error: `Run already ${run.status}`, run: summarizeRun(run) });
        return;
      }

      run.cancelRequested = true;
      run.updatedAt = nowIso();
      run.error = "Run canceled by user";

      if (run.status === "queued") {
        const idx = queue.indexOf(id);
        if (idx >= 0) queue.splice(idx, 1);
        run.status = "canceled";
        run.finishedAt = nowIso();
        sendJson(res, 200, { ok: true, run: summarizeRun(run) });
        setImmediate(drainQueue);
        return;
      }

      if (run.status === "running" && activeRunId === id && activeChild) {
        let killed = false;
        if (typeof activeChild.pid === "number" && activeChild.pid > 0) {
          try {
            process.kill(-activeChild.pid, "SIGTERM");
            killed = true;
          } catch {}
        }
        if (!killed) {
          killed = activeChild.kill("SIGTERM");
        }
        if (!killed) {
          activeChild.kill("SIGKILL");
        } else {
          setTimeout(() => {
            if (activeRunId === id && activeChild) {
              if (typeof activeChild.pid === "number" && activeChild.pid > 0) {
                try {
                  process.kill(-activeChild.pid, "SIGKILL");
                  return;
                } catch {}
              }
              activeChild.kill("SIGKILL");
            }
          }, 2000);
        }
        sendJson(res, 202, { ok: true, run: summarizeRun(run), message: "Cancel requested" });
        return;
      }

      sendJson(res, 202, { ok: true, run: summarizeRun(run), message: "Cancel requested" });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

await mkdir(outDir, { recursive: true });
server.listen(port, host, () => {
  console.log(`agent-proof-server listening on http://${host}:${port}`);
});
