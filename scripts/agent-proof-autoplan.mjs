#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { parseArgs } from "util";
import { spawn } from "child_process";
import puppeteer from "puppeteer-core";

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean value "${value}"`);
}

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

function normalizeAssertions(assertions) {
  if (!assertions) return [];
  if (!Array.isArray(assertions)) throw new Error("assertions must be an array");
  return assertions.filter((item) => item && typeof item === "object");
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

async function scanDom(url, chromePath, width, height) {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const snapshot = await page.evaluate(() => {
      const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const lower = (value) => norm(value).toLowerCase();
      const cssEscape = (value) => {
        if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, "\\$&");
      };
      const selectorFor = (el) => {
        if (!el) return "";
        if (el.id) return `#${cssEscape(el.id)}`;
        const testId = el.getAttribute("data-testid");
        if (testId) return `[data-testid="${cssEscape(testId)}"]`;
        const name = el.getAttribute("name");
        if (name && /^(input|textarea|select)$/i.test(el.tagName)) {
          return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
        }
        const aria = el.getAttribute("aria-label");
        if (aria && /^(input|textarea|select|button|a)$/i.test(el.tagName)) {
          return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
        }
        return "";
      };
      const visible = (el) => {
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

      const inputNodes = Array.from(document.querySelectorAll("input, textarea, select"))
        .filter(visible)
        .map((el) => ({
          selector: selectorFor(el),
          type: lower(el.getAttribute("type") || el.tagName),
          name: lower(el.getAttribute("name")),
          id: lower(el.id),
          placeholder: lower(el.getAttribute("placeholder")),
          ariaLabel: lower(el.getAttribute("aria-label")),
        }))
        .filter((entry) => entry.selector);

      const clickNodes = Array.from(
        document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button']")
      )
        .filter(visible)
        .map((el) => ({
          selector: selectorFor(el),
          text: lower(el.innerText || el.textContent || el.value),
        }))
        .filter((entry) => entry.selector || entry.text);

      return { inputNodes, clickNodes };
    });
    return snapshot;
  } finally {
    await browser.close().catch(() => {});
  }
}

function textIn(value, ...needles) {
  const source = String(value || "").toLowerCase();
  return needles.some((needle) => source.includes(String(needle).toLowerCase()));
}

function pickInput(snapshot, matcher) {
  return snapshot.inputNodes.find((node) => matcher([node.type, node.name, node.id, node.placeholder, node.ariaLabel].join(" ")));
}

function pickClick(snapshot, matcher) {
  return snapshot.clickNodes.find((node) => matcher(node.text));
}

function generateActions({ goal, assertions, snapshot }) {
  const plan = [];
  const goalText = String(goal || "").toLowerCase();
  const assertionText = assertions.map((item) => String(item.value || "")).join(" ").toLowerCase();
  const combined = `${goalText} ${assertionText}`.trim();

  const bootTarget = pickClick(snapshot, (txt) => textIn(txt, "boot"));
  if (textIn(combined, "boot") && bootTarget) {
    plan.push({ type: "wait", ms: 500 });
    plan.push(
      bootTarget.selector
        ? { type: "click", selector: bootTarget.selector }
        : { type: "click", text: "boot" }
    );
    plan.push({ type: "wait", ms: 900 });
  }

  const emailInput = pickInput(snapshot, (txt) => textIn(txt, "email"));
  const passwordInput = pickInput(snapshot, (txt) => textIn(txt, "password"));
  const needsAuth =
    textIn(combined, "login", "sign in", "signup", "sign up", "trial", "email", "register");
  if (needsAuth && emailInput) {
    plan.push({ type: "click", selector: emailInput.selector });
    plan.push({ type: "type", selector: emailInput.selector, text: "qa+autoplan@pelianlabs.com", clear: true });
  }
  if (needsAuth && passwordInput) {
    plan.push({ type: "type", selector: passwordInput.selector, text: "secret-pass", clear: true });
  }

  const submitButton = pickClick(snapshot, (txt) => textIn(txt, "sign in", "sign up", "submit", "start", "continue", "trial", "book demo"));
  if ((emailInput || passwordInput) && submitButton) {
    plan.push(
      submitButton.selector
        ? { type: "click", selector: submitButton.selector }
        : { type: "click", text: "submit" }
    );
  }

  for (const assertion of assertions) {
    const kind = String(assertion.type || "").toLowerCase();
    const value = String(assertion.value || "").trim();
    if (!value) continue;
    if (kind === "text_visible") {
      plan.push({ type: "wait_for", containsText: value, timeoutMs: 5000 });
      continue;
    }
    if (kind === "clickable") {
      const target = pickClick(snapshot, (txt) => txt.includes(value.toLowerCase()));
      if (target?.selector) {
        plan.push({ type: "click", selector: target.selector });
      } else {
        plan.push({ type: "click", text: value });
      }
    }
  }

  if (plan.length === 0) {
    plan.push({ type: "wait", ms: 1000 });
  }
  plan.push({ type: "wait", ms: 700 });
  return plan;
}

async function main() {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      url: { type: "string" },
      mode: { type: "string" },
      name: { type: "string" },
      goal: { type: "string" },
      output: { type: "string" },
      "out-dir": { type: "string", default: "./proofs" },
      duration: { type: "string" },
      profile: { type: "string" },
      chrome: { type: "string" },
      build: { type: "string" },
      "autoplan-experimental": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage:
  node scripts/agent-proof-autoplan.mjs --spec ./autoplan-spec.json --autoplan-experimental true
`);
    return;
  }

  const autoplanEnabled = boolArg(
    pick(values["autoplan-experimental"], process.env.AGENT_PROOF_ENABLE_AUTOPLAN, "false"),
    false
  );
  if (!autoplanEnabled) {
    throw new Error(
      "AutoPlanner is experimental. Re-run with --autoplan-experimental true or AGENT_PROOF_ENABLE_AUTOPLAN=1."
    );
  }

  const spec = await loadSpec(values.spec);
  const url = pick(values.url, spec.url);
  if (!url) throw new Error("Missing url");
  const mode = String(pick(values.mode, spec.mode, "after")).toLowerCase() === "before" ? "before" : "after";
  const name = String(pick(values.name, spec.name, "autoplan-proof")).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const goal = String(pick(values.goal, spec.goal, ""));
  const assertions = normalizeAssertions(spec.assertions);
  const duration = Number.parseInt(String(pick(values.duration, spec.duration, "10")), 10);

  const profileName = String(pick(values.profile, spec.profile, "efficient")).toLowerCase();
  const profileMap = {
    default: { width: 1280, height: 720 },
    smooth: { width: 1280, height: 720 },
    efficient: { width: 960, height: 540 },
  };
  const profile = profileMap[profileName] || profileMap.efficient;

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

  const snapshot = await scanDom(String(url), chromePath, profile.width, profile.height);
  const generatedActions = generateActions({ goal, assertions, snapshot });
  const actionsPath = `${output}.autoplan.actions.json`;
  await writeFile(actionsPath, `${JSON.stringify(generatedActions, null, 2)}\n`, "utf8");

  const recorderArgs = [
    "./scripts/agent-proof.mjs",
    "--url", String(url),
    "--mode", mode,
    "--name", `${name}-autoplan`,
    "--output", output,
    "--duration", String(duration),
    "--profile", profileName,
    "--actions", `@${actionsPath}`,
    "--build", String(pick(values.build, spec.build, "false")),
    "--chrome", chromePath,
  ];
  const recorder = spawn("node", recorderArgs, { stdio: "inherit" });
  await waitForChild(recorder);

  const sidecarPath = `${output}.proof.json`;
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  sidecar.controlMode = "autoplan";
  sidecar.autoplanExperimental = true;
  sidecar.goal = goal;
  sidecar.assertions = assertions;
  sidecar.generatedActions = generatedActions;
  sidecar.domSnapshotSummary = {
    inputs: snapshot.inputNodes.length,
    clickables: snapshot.clickNodes.length,
  };
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    output,
    sidecar: sidecarPath,
    actions: actionsPath,
    actionCount: generatedActions.length,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[agent-proof-autoplan] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
