#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { spawn } from "child_process";
import { parseArgs } from "util";

const CAPTURE_PROFILES = {
  default: { width: 1280, height: 720, fps: 10, jpegQuality: 90 },
  smooth: { width: 1280, height: 720, fps: 15, jpegQuality: 82 },
  efficient: { width: 960, height: 540, fps: 15, jpegQuality: 78 },
};

const ACTION_PACE_PRESETS = {
  fast: { startDelayMs: 180, stepDelayMs: 120, typingDelayMs: 20, pollMs: 60, defaultTimeoutMs: 4500 },
  normal: { startDelayMs: 420, stepDelayMs: 260, typingDelayMs: 45, pollMs: 80, defaultTimeoutMs: 7000 },
  cinematic: { startDelayMs: 700, stepDelayMs: 420, typingDelayMs: 70, pollMs: 100, defaultTimeoutMs: 9000 },
};

const SUPPORTED_ACTIONS = new Set([
  "wait",
  "wait_for",
  "click",
  "type",
  "press",
  "focus",
  "hover",
  "scroll_by",
  "scroll_to",
  "toggle",
  "select",
  "evaluate",
]);

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

function normalizeActionList(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions)) {
    throw new Error("actions must be an array of action objects");
  }
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`actions[${i}] must be an object`);
    }
    const type = String(action.type ?? "").toLowerCase().trim();
    if (!type) throw new Error(`actions[${i}].type is required`);
    if (!SUPPORTED_ACTIONS.has(type)) {
      throw new Error(
        `Unsupported action type "${action.type}" at actions[${i}]. Supported: ${Array.from(SUPPORTED_ACTIONS).join(", ")}`
      );
    }
  }
  return actions;
}

async function loadActions(cliRaw, specRaw) {
  if (cliRaw === undefined) {
    return normalizeActionList(specRaw);
  }
  const raw = String(cliRaw).trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    return normalizeActionList(JSON.parse(raw));
  }
  const pathLike = raw.startsWith("@") ? raw.slice(1) : raw;
  const content = await readFile(resolve(pathLike), "utf8");
  return normalizeActionList(JSON.parse(content));
}

function buildActionScript(actions, actionConfig) {
  const actionsJson = JSON.stringify(actions);
  const configJson = JSON.stringify(actionConfig);
  return `(() => {
  const actions = ${actionsJson};
  const config = ${configJson};

  const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, Number(ms) || 0)));
  const toNum = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim().toLowerCase();
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= 0 || rect.top >= (window.innerHeight || 0)) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const byXPath = (xpath) => {
    if (!xpath) return null;
    try {
      return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue || null;
    } catch (_) {
      return null;
    }
  };
  const firstVisible = (nodes) => {
    for (const node of nodes) {
      if (isVisible(node)) return node;
    }
    return null;
  };
  const resolveByText = (text, interactiveOnly = false) => {
    const needle = normalize(text);
    if (!needle) return null;
    const selector = interactiveOnly
      ? "button, a, [role='button'], input, textarea, select, summary, label, [tabindex]"
      : "button, a, [role='button'], input, textarea, select, summary, label, [tabindex], div, span, p, h1, h2, h3, h4, h5";
    const nodes = Array.from(document.querySelectorAll(selector));
    const ranked = nodes
      .map((el) => {
        if (!isVisible(el)) return null;
        const textContent = normalize(el.innerText || el.textContent || el.value || "");
        if (!textContent.includes(needle)) return null;
        const rect = el.getBoundingClientRect();
        return { el, score: textContent === needle ? 2 : 1, area: rect.width * rect.height };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.area - a.area;
      });
    return ranked.length ? ranked[0].el : null;
  };
  const resolveTarget = (action, options = {}) => {
    const interactiveOnly = Boolean(options.interactiveOnly);
    if (action.selector) {
      const direct = document.querySelector(action.selector);
      if (isVisible(direct)) return direct;
    }
    if (action.xpath) {
      const node = byXPath(action.xpath);
      if (isVisible(node)) return node;
    }
    if (action.text) {
      const fromText = resolveByText(action.text, interactiveOnly);
      if (!fromText) return null;
      if (!interactiveOnly) return fromText;
      return fromText.closest("button, a, [role='button'], label, summary, [tabindex], input, textarea, select") || fromText;
    }
    return null;
  };
  const waitForTarget = async (action, options = {}) => {
    const timeoutMs = toNum(action.timeoutMs, toNum(config.defaultTimeoutMs, 5000));
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const node = resolveTarget(action, options);
      if (node) return node;
      if (action.containsText) {
        const bodyText = normalize(document.body?.innerText || "");
        if (bodyText.includes(normalize(action.containsText))) return document.body;
      }
      await delay(toNum(config.pollMs, 80));
    }
    return null;
  };
  const centerPoint = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.floor(rect.left + rect.width / 2),
      y: Math.floor(rect.top + rect.height / 2),
    };
  };
  const dispatchMouseSequence = (target, x, y) => {
    if (!target) return false;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, opts));
    }
    if (typeof target.click === "function") target.click();
    return true;
  };
  const clickPoint = (x, y) => {
    const target = document.elementFromPoint(Math.floor(x), Math.floor(y));
    if (!target) return false;
    return dispatchMouseSequence(target, Math.floor(x), Math.floor(y));
  };
  const setInputValue = (el, nextValue) => {
    const prototype = Object.getPrototypeOf(el);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
    if (descriptor && typeof descriptor.set === "function") {
      descriptor.set.call(el, nextValue);
      return;
    }
    el.value = nextValue;
  };
  const typeInto = async (target, text, perKeyDelay) => {
    target.focus({ preventScroll: true });
    for (const char of String(text ?? "")) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
      setInputValue(target, String(target.value ?? "") + char);
      target.dispatchEvent(new InputEvent("input", { data: char, inputType: "insertText", bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true, cancelable: true }));
      if (perKeyDelay > 0) await delay(perKeyDelay);
    }
  };

  const runAction = async (action) => {
    const type = String(action.type || "").toLowerCase();
    switch (type) {
      case "wait": {
        await delay(toNum(action.ms, 250));
        return;
      }
      case "wait_for": {
        const target = await waitForTarget(action, { interactiveOnly: Boolean(action.interactiveOnly) });
        if (!target) throw new Error("wait_for target not found");
        return;
      }
      case "click": {
        const target = await waitForTarget(action, { interactiveOnly: true });
        if (target) {
          target.scrollIntoView({ block: action.block || "center", inline: "center", behavior: action.behavior || "instant" });
          await delay(toNum(action.preDelayMs, 40));
          const point = centerPoint(target);
          dispatchMouseSequence(target, point.x, point.y);
          return;
        }
        if (Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y))) {
          if (!clickPoint(Number(action.x), Number(action.y))) {
            throw new Error("click coordinates did not resolve an element");
          }
          return;
        }
        throw new Error("click target not found");
      }
      case "focus": {
        const target = await waitForTarget(action, { interactiveOnly: false });
        if (!target) throw new Error("focus target not found");
        target.focus({ preventScroll: true });
        return;
      }
      case "hover": {
        const target = await waitForTarget(action, { interactiveOnly: false });
        if (!target) throw new Error("hover target not found");
        const point = centerPoint(target);
        for (const typeName of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
          target.dispatchEvent(new MouseEvent(typeName, {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
          }));
        }
        return;
      }
      case "type": {
        const target = await waitForTarget(action, { interactiveOnly: false });
        if (!target) throw new Error("type target not found");
        if (target.isContentEditable) {
          target.focus({ preventScroll: true });
          if (action.clear !== false) target.textContent = "";
          const base = action.clear === false ? String(target.textContent || "") : "";
          target.textContent = base + String(action.text ?? "");
          target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
          return;
        }
        const shouldClear = action.clear !== false;
        if (shouldClear && "value" in target) {
          setInputValue(target, "");
          target.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true }));
        }
        const typingDelay = toNum(action.delayMs, toNum(config.typingDelayMs, 25));
        await typeInto(target, action.text ?? "", typingDelay);
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      case "press": {
        const key = String(action.key || "Enter");
        const target = await waitForTarget(action, { interactiveOnly: false }) || document.activeElement;
        if (!target) throw new Error("press target not found");
        target.focus?.({ preventScroll: true });
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keypress", { key, bubbles: true, cancelable: true }));
        if (key === "Enter") {
          const form = target.form || target.closest?.("form");
          if (form && typeof form.requestSubmit === "function") form.requestSubmit();
        }
        target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
        return;
      }
      case "scroll_by": {
        window.scrollBy({
          top: toNum(action.y, 0),
          left: toNum(action.x, 0),
          behavior: action.behavior || "smooth",
        });
        await delay(toNum(action.ms, 350));
        return;
      }
      case "scroll_to": {
        const target = resolveTarget(action, { interactiveOnly: false });
        if (target) {
          target.scrollIntoView({ block: action.block || "center", inline: "center", behavior: action.behavior || "smooth" });
          await delay(toNum(action.ms, 350));
          return;
        }
        window.scrollTo({
          top: toNum(action.y, 0),
          left: toNum(action.x, 0),
          behavior: action.behavior || "smooth",
        });
        await delay(toNum(action.ms, 350));
        return;
      }
      case "toggle": {
        const target = await waitForTarget(action, { interactiveOnly: false });
        if (!target) throw new Error("toggle target not found");
        const shouldCheck = action.value === undefined ? null : Boolean(action.value);
        if ("checked" in target) {
          if (shouldCheck === null || target.checked !== shouldCheck) {
            target.checked = shouldCheck === null ? !target.checked : shouldCheck;
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return;
        }
        const point = centerPoint(target);
        dispatchMouseSequence(target, point.x, point.y);
        return;
      }
      case "select": {
        const target = await waitForTarget(action, { interactiveOnly: false });
        if (!target) throw new Error("select target not found");
        if (target.tagName !== "SELECT") throw new Error("select target is not <select>");
        target.value = String(action.value ?? "");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      case "evaluate": {
        if (!action.expression) throw new Error("evaluate.expression is required");
        // eslint-disable-next-line no-eval
        eval(String(action.expression));
        return;
      }
      default:
        throw new Error("Unsupported action type: " + type);
    }
  };

  const run = async () => {
    await delay(toNum(config.startDelayMs, 200));
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      try {
        await runAction(action);
        console.log("[agent-actions] step " + (i + 1) + "/" + actions.length + " ok: " + action.type);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.log("[agent-actions] step " + (i + 1) + "/" + actions.length + " failed: " + message);
        if (!config.continueOnError) throw err;
      }
      await delay(toNum(action.stepDelayMs, toNum(config.stepDelayMs, 180)));
    }
    console.log("[agent-actions] finished " + actions.length + " steps");
  };

  run().catch((err) => {
    const message = err && err.message ? err.message : String(err);
    console.log("[agent-actions] fatal: " + message);
  });
})();`;
}

function parseProfile(rawValue) {
  const value = String(rawValue ?? "default").toLowerCase().trim();
  if (!CAPTURE_PROFILES[value]) {
    throw new Error(`profile must be one of: ${Object.keys(CAPTURE_PROFILES).join(", ")}. Received "${rawValue}"`);
  }
  return value;
}

function parseActionPace(rawValue) {
  const value = String(rawValue ?? "normal").toLowerCase().trim();
  if (!ACTION_PACE_PRESETS[value]) {
    throw new Error(
      `pace must be one of: ${Object.keys(ACTION_PACE_PRESETS).join(", ")}. Received "${rawValue}"`
    );
  }
  return value;
}

async function main() {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      actions: { type: "string" },
      url: { type: "string" },
      mode: { type: "string" }, // before|after
      name: { type: "string" },
      goal: { type: "string" },
      output: { type: "string" },
      "out-dir": { type: "string", default: "./proofs" },
      profile: { type: "string" }, // default|smooth|efficient
      pace: { type: "string" }, // fast|normal|cinematic
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
  node scripts/agent-proof.mjs --spec ./proof-spec.json --profile efficient
  node scripts/agent-proof.mjs --spec ./proof-spec.json --pace cinematic
  node scripts/agent-proof.mjs --url <url> --actions @./actions.json

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
  const profileName = parseProfile(pick(values.profile, spec.profile, "default"));
  const profile = CAPTURE_PROFILES[profileName];
  const paceName = parseActionPace(pick(values.pace, spec.pace, "cinematic"));
  const pacePreset = ACTION_PACE_PRESETS[paceName];
  const actions = await loadActions(values.actions, spec.actions);
  const actionConfig = {
    continueOnError: boolArg(pick(spec.actionConfig?.continueOnError, true), true),
    startDelayMs: parseIntegerArg("actionConfig.startDelayMs", pick(spec.actionConfig?.startDelayMs, String(pacePreset.startDelayMs)), { min: 0, max: 60000 }),
    stepDelayMs: parseIntegerArg("actionConfig.stepDelayMs", pick(spec.actionConfig?.stepDelayMs, String(pacePreset.stepDelayMs)), { min: 0, max: 60000 }),
    typingDelayMs: parseIntegerArg("actionConfig.typingDelayMs", pick(spec.actionConfig?.typingDelayMs, String(pacePreset.typingDelayMs)), { min: 0, max: 1000 }),
    pollMs: parseIntegerArg("actionConfig.pollMs", pick(spec.actionConfig?.pollMs, String(pacePreset.pollMs)), { min: 10, max: 2000 }),
    defaultTimeoutMs: parseIntegerArg("actionConfig.defaultTimeoutMs", pick(spec.actionConfig?.defaultTimeoutMs, String(pacePreset.defaultTimeoutMs)), { min: 50, max: 120000 }),
  };

  const duration = parseIntegerArg("duration", pick(values.duration, spec.duration, "8"), { min: 1, max: 7200 });
  const width = parseIntegerArg("width", pick(values.width, spec.width, String(profile.width)), { min: 16, max: 7680 });
  const height = parseIntegerArg("height", pick(values.height, spec.height, String(profile.height)), { min: 16, max: 4320 });
  const fps = parseIntegerArg("fps", pick(values.fps, spec.fps, String(profile.fps)), { min: 1, max: 60 });
  const jpegQuality = parseIntegerArg("jpeg-quality", pick(values["jpeg-quality"], spec.jpegQuality, String(profile.jpegQuality)), { min: 1, max: 100 });
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

  const explicitScriptPath = pick(values.script, spec.script);
  let generatedActionScript = "";
  if (explicitScriptPath && actions.length > 0) {
    throw new Error("Use either script or actions, not both, for a single run.");
  }
  if (actions.length > 0) {
    generatedActionScript = `${output}.actions.generated.js`;
    const scriptContent = buildActionScript(actions, actionConfig);
    await writeFile(generatedActionScript, `${scriptContent}\n`, "utf8");
  }
  const finalScriptPath = generatedActionScript || explicitScriptPath;

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
    ["--script", finalScriptPath],
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
  const parsedFrames = Number(metrics.nb_frames);
  const parsedDuration = Number(metrics.duration);
  if (Number.isFinite(parsedFrames) && Number.isFinite(parsedDuration) && parsedDuration > 0) {
    metrics.effective_fps = (parsedFrames / parsedDuration).toFixed(3);
  }

  const sidecarPath = `${output}.proof.json`;
  const payload = {
    mode,
    name,
    url,
    goal,
    assertions,
    profile: profileName,
    pace: paceName,
    actions,
    actionConfig,
    actionScript: generatedActionScript || null,
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
