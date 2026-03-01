#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { parseArgs } from "util";
import puppeteer from "puppeteer-core";

const CAPTURE_PROFILES = {
  default: { width: 1280, height: 720, fps: 10, jpegQuality: 90 },
  smooth: { width: 1280, height: 720, fps: 15, jpegQuality: 82 },
  efficient: { width: 960, height: 540, fps: 15, jpegQuality: 78 },
};

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, Number(ms) || 0)));

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

function parseIntegerArg(name, rawValue, { min, max }) {
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}. Received "${rawValue}".`);
  }
  return parsed;
}

function normalizeActionList(actions) {
  if (!Array.isArray(actions)) throw new Error("actions must be an array");
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`actions[${i}] must be an object`);
    }
    if (!action.type) throw new Error(`actions[${i}].type is required`);
  }
  return actions;
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

async function loadActions(cliRaw, specRaw) {
  if (cliRaw === undefined) {
    return normalizeActionList(specRaw ?? []);
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

async function waitForDevtools(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  throw new Error(`Timed out waiting for DevTools on port ${port}`);
}

async function pageWsEndpointForUrl(port, url, timeoutMs = 10000) {
  const start = Date.now();
  const targetUrl = String(url || "");
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const pages = Array.isArray(targets) ? targets.filter((item) => item?.type === "page") : [];
        const exact = pages.find((item) => item.url === targetUrl && item.webSocketDebuggerUrl);
        if (exact) return exact.webSocketDebuggerUrl;
        const fuzzy = pages.find((item) => targetUrl && item.url && item.url.includes(targetUrl) && item.webSocketDebuggerUrl);
        if (fuzzy) return fuzzy.webSocketDebuggerUrl;
        const fallback = pages.find((item) => item.webSocketDebuggerUrl);
        if (fallback) return fallback.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 120));
  }
  throw new Error("Timed out finding page websocket endpoint");
}

function waitForChild(child) {
  return new Promise((resolveRun, rejectRun) => {
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveRun({ code, signal });
        return;
      }
      rejectRun(new Error(`child exited with code=${code ?? "null"} signal=${signal ?? "none"}`));
    });
  });
}

async function runAction(page, action, defaults) {
  const type = String(action.type).toLowerCase().trim();
  const timeoutMs = Number(action.timeoutMs ?? defaults.defaultTimeoutMs);
  switch (type) {
    case "wait": {
      await delay(Number(action.ms ?? 250));
      return;
    }
    case "wait_for": {
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
        return;
      }
      if (action.containsText) {
        const text = String(action.containsText);
        await page.waitForFunction(
          (needle) => (document.body?.innerText || "").toLowerCase().includes(needle.toLowerCase()),
          { timeout: timeoutMs },
          text
        );
        return;
      }
      throw new Error("wait_for requires selector or containsText");
    }
    case "click": {
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
        await page.click(action.selector);
        return;
      }
      if (action.text) {
        const text = String(action.text).toLowerCase();
        const clicked = await page.evaluate((needle) => {
          const candidates = Array.from(
            document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button'], [tabindex], div, span")
          );
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < (window.innerHeight || 0) &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          };
          const target = candidates.find((el) => {
            if (!isVisible(el)) return false;
            const txt = (el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim().toLowerCase();
            return txt.includes(needle);
          });
          if (!target) return false;
          target.click();
          return true;
        }, text);
        if (!clicked) throw new Error(`click text target not found: ${action.text}`);
        return;
      }
      if (Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y))) {
        await page.mouse.click(Number(action.x), Number(action.y));
        return;
      }
      throw new Error("click requires selector, text, or coordinates");
    }
    case "type": {
      if (!action.selector) throw new Error("type requires selector");
      await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
      await page.focus(action.selector);
      if (action.clear !== false) {
        await page.$eval(action.selector, (el) => {
          if ("value" in el) el.value = "";
        });
      }
      await page.type(action.selector, String(action.text ?? ""), { delay: Number(action.delayMs ?? defaults.typingDelayMs) });
      return;
    }
    case "press": {
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
        await page.focus(action.selector);
      }
      await page.keyboard.press(String(action.key || "Enter"));
      return;
    }
    case "focus": {
      if (!action.selector) throw new Error("focus requires selector");
      await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
      await page.focus(action.selector);
      return;
    }
    case "hover": {
      if (!action.selector) throw new Error("hover requires selector");
      await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
      await page.hover(action.selector);
      return;
    }
    case "scroll_by": {
      await page.evaluate(
        ({ x, y, behavior }) => {
          window.scrollBy({ left: Number(x || 0), top: Number(y || 0), behavior: behavior || "smooth" });
        },
        { x: action.x ?? 0, y: action.y ?? 0, behavior: action.behavior }
      );
      await delay(Number(action.ms ?? 350));
      return;
    }
    case "scroll_to": {
      if (action.selector) {
        await page.waitForSelector(action.selector, { timeout: timeoutMs });
        await page.$eval(action.selector, (el) => el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" }));
      } else {
        await page.evaluate(
          ({ x, y, behavior }) => {
            window.scrollTo({ left: Number(x || 0), top: Number(y || 0), behavior: behavior || "smooth" });
          },
          { x: action.x ?? 0, y: action.y ?? 0, behavior: action.behavior }
        );
      }
      await delay(Number(action.ms ?? 350));
      return;
    }
    case "toggle": {
      if (!action.selector) throw new Error("toggle requires selector");
      await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
      await page.$eval(
        action.selector,
        (el, desired) => {
          const next = desired === null ? !Boolean(el.checked) : Boolean(desired);
          if ("checked" in el) {
            el.checked = next;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return;
          }
          el.click();
        },
        action.value === undefined ? null : Boolean(action.value)
      );
      return;
    }
    case "select": {
      if (!action.selector) throw new Error("select requires selector");
      await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
      await page.select(action.selector, String(action.value ?? ""));
      return;
    }
    case "evaluate": {
      if (!action.expression) throw new Error("evaluate.expression is required");
      await page.evaluate((expression) => {
        // eslint-disable-next-line no-eval
        eval(expression);
      }, String(action.expression));
      return;
    }
    default:
      throw new Error(`Unsupported action type: ${action.type}`);
  }
}

async function runActions(page, actions, actionConfig) {
  await delay(Number(actionConfig.startDelayMs));
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    try {
      await runAction(page, action, actionConfig);
      console.log(`[live-actions] step ${i + 1}/${actions.length} ok: ${action.type}`);
    } catch (err) {
      console.log(`[live-actions] step ${i + 1}/${actions.length} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!actionConfig.continueOnError) throw err;
    }
    await delay(Number(action.stepDelayMs ?? actionConfig.stepDelayMs));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      actions: { type: "string" },
      url: { type: "string" },
      mode: { type: "string" },
      name: { type: "string" },
      output: { type: "string" },
      "out-dir": { type: "string", default: "./proofs" },
      profile: { type: "string", default: "efficient" },
      duration: { type: "string", default: "10" },
      chrome: { type: "string" },
      build: { type: "string", default: "false" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage:
  node scripts/agent-proof-live.mjs --spec ./live-spec.json
  node scripts/agent-proof-live.mjs --url https://example.com --actions @./actions.json
`);
    return;
  }

  const spec = await loadSpec(values.spec);
  const url = pick(values.url, spec.url);
  if (!url) throw new Error("Missing url");
  const actions = await loadActions(values.actions, spec.actions);
  if (actions.length === 0) throw new Error("No actions provided");

  const profileName = String(pick(values.profile, spec.profile, "efficient")).toLowerCase();
  const profile = CAPTURE_PROFILES[profileName];
  if (!profile) throw new Error(`Unsupported profile "${profileName}"`);

  const mode = String(pick(values.mode, spec.mode, "after")).toLowerCase() === "before" ? "before" : "after";
  const name = String(pick(values.name, spec.name, "live-proof")).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const duration = parseIntegerArg("duration", pick(values.duration, spec.duration, "10"), { min: 1, max: 7200 });
  const outDir = resolve(String(pick(values["out-dir"], spec.outDir, "./proofs")));
  await mkdir(outDir, { recursive: true });
  const output = resolve(String(pick(values.output, spec.output, `${outDir}/${mode}-${name}-${nowStamp()}.mp4`)));
  await mkdir(dirname(output), { recursive: true });

  const chromePath = String(
    pick(
      values.chrome,
      spec.chrome,
      "/tmp/puppeteer-browsers/chromium/mac_arm-1591460/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
    )
  );
  const port = parseIntegerArg("debug-port", pick(spec.debugPort, "9229"), { min: 1024, max: 65535 });
  const userDataDir = await mkdtemp(resolve(tmpdir(), "agent-proof-live-"));

  let chromeChild;
  let browser;
  try {
    chromeChild = spawn(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ], { stdio: "ignore" });

    const version = await waitForDevtools(port);
    browser = await puppeteer.connect({ browserWSEndpoint: version.webSocketDebuggerUrl });
    const page = await browser.newPage();
    await page.setViewport({ width: profile.width, height: profile.height });
    await page.goto(String(url), { waitUntil: "domcontentloaded", timeout: 30000 });

    const pageWsEndpoint = await pageWsEndpointForUrl(port, page.url());
    const recorderArgs = [
      "./scripts/agent-proof.mjs",
      "--url", String(url),
      "--mode", mode,
      "--name", `${name}-live`,
      "--output", output,
      "--duration", String(duration),
      "--width", String(profile.width),
      "--height", String(profile.height),
      "--fps", String(profile.fps),
      "--jpeg-quality", String(profile.jpegQuality),
      "--ws-endpoint", pageWsEndpoint,
      "--build", String(pick(values.build, spec.build, "false")),
    ];

    const recorder = spawn("node", recorderArgs, { stdio: "inherit" });
    const actionConfig = {
      continueOnError: Boolean(spec.actionConfig?.continueOnError ?? true),
      startDelayMs: Number(spec.actionConfig?.startDelayMs ?? 250),
      stepDelayMs: Number(spec.actionConfig?.stepDelayMs ?? 180),
      defaultTimeoutMs: Number(spec.actionConfig?.defaultTimeoutMs ?? 5000),
      typingDelayMs: Number(spec.actionConfig?.typingDelayMs ?? 25),
    };

    await runActions(page, actions, actionConfig);
    await waitForChild(recorder);

    const sidecarPath = `${output}.proof.json`;
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    sidecar.controlMode = "puppeteer-live";
    sidecar.executedActions = actions;
    sidecar.actionConfig = actionConfig;
    await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, output, sidecar: sidecarPath }, null, 2));
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (chromeChild) {
      chromeChild.kill("SIGKILL");
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[agent-proof-live] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
