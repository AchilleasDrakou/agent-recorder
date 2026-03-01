#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { dirname, resolve } from "path";
import { parseArgs } from "util";
import net from "net";
import puppeteer from "puppeteer-core";

const CAPTURE_PROFILES = {
  default: { width: 1280, height: 720, fps: 10, jpegQuality: 90 },
  smooth: { width: 1280, height: 720, fps: 15, jpegQuality: 82 },
  efficient: { width: 960, height: 540, fps: 15, jpegQuality: 78 },
};

const PACE_PRESETS = {
  fast: {
    startDelayMs: 180,
    stepDelayMs: 120,
    typingDelayMs: 18,
    defaultTimeoutMs: 5000,
    mouseSteps: 8,
    preClickDelayMs: 20,
    clickHoldMs: 30,
    postClickDelayMs: 30,
    scrollSettleMs: 280,
    hoverMs: 100,
  },
  normal: {
    startDelayMs: 420,
    stepDelayMs: 260,
    typingDelayMs: 45,
    defaultTimeoutMs: 7000,
    mouseSteps: 14,
    preClickDelayMs: 70,
    clickHoldMs: 70,
    postClickDelayMs: 80,
    scrollSettleMs: 620,
    hoverMs: 180,
  },
  cinematic: {
    startDelayMs: 700,
    stepDelayMs: 420,
    typingDelayMs: 70,
    defaultTimeoutMs: 9000,
    mouseSteps: 20,
    preClickDelayMs: 120,
    clickHoldMs: 120,
    postClickDelayMs: 140,
    scrollSettleMs: 900,
    hoverMs: 260,
  },
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

async function findFreePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const server = net.createServer();
    server.unref();
    server.on("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Failed to allocate free debug port"));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          rejectPort(err);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

function parseIntegerArg(name, rawValue, { min, max }) {
  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}. Received "${rawValue}".`);
  }
  return parsed;
}

function boolArg(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const v = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean value "${value}"`);
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
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode === 0) {
        resolveRun({ code: child.exitCode, signal: child.signalCode });
        return;
      }
      rejectRun(
        new Error(`child exited with code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "none"}`)
      );
      return;
    }
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

function parsePace(rawValue) {
  const pace = String(rawValue ?? "cinematic").toLowerCase().trim();
  if (!PACE_PRESETS[pace]) {
    throw new Error(`pace must be one of: ${Object.keys(PACE_PRESETS).join(", ")}. Received "${rawValue}"`);
  }
  return pace;
}

function mergeActionConfig(specActionConfig, pace) {
  const preset = PACE_PRESETS[pace];
  return {
    continueOnError: Boolean(specActionConfig?.continueOnError ?? true),
    startDelayMs: Number(specActionConfig?.startDelayMs ?? preset.startDelayMs),
    stepDelayMs: Number(specActionConfig?.stepDelayMs ?? preset.stepDelayMs),
    defaultTimeoutMs: Number(specActionConfig?.defaultTimeoutMs ?? preset.defaultTimeoutMs),
    typingDelayMs: Number(specActionConfig?.typingDelayMs ?? preset.typingDelayMs),
    mouseSteps: Number(specActionConfig?.mouseSteps ?? preset.mouseSteps),
    preClickDelayMs: Number(specActionConfig?.preClickDelayMs ?? preset.preClickDelayMs),
    clickHoldMs: Number(specActionConfig?.clickHoldMs ?? preset.clickHoldMs),
    postClickDelayMs: Number(specActionConfig?.postClickDelayMs ?? preset.postClickDelayMs),
    scrollSettleMs: Number(specActionConfig?.scrollSettleMs ?? preset.scrollSettleMs),
    hoverMs: Number(specActionConfig?.hoverMs ?? preset.hoverMs),
    cursorMoveMs: Number(specActionConfig?.cursorMoveMs ?? (pace === "cinematic" ? 420 : pace === "normal" ? 260 : 130)),
  };
}

function estimateDurationMs(actions, defaults) {
  let total = Number(defaults.startDelayMs) + 2000;
  for (const action of actions) {
    const type = String(action.type || "").toLowerCase();
    switch (type) {
      case "wait":
        total += Number(action.ms ?? 250);
        break;
      case "type":
        total += 250 + String(action.text ?? "").length * Number(action.delayMs ?? defaults.typingDelayMs);
        break;
      case "wait_for":
        total += Math.min(Number(action.timeoutMs ?? defaults.defaultTimeoutMs), 2200);
        break;
      case "scroll_by":
      case "scroll_to":
        total += Number(action.ms ?? defaults.scrollSettleMs);
        break;
      case "click":
      case "toggle":
      case "select":
      case "press":
      case "focus":
      case "hover":
        total += Number(defaults.cursorMoveMs) + Number(defaults.preClickDelayMs) + Number(defaults.clickHoldMs) + Number(defaults.postClickDelayMs);
        break;
      default:
        total += 220;
        break;
    }
    total += Number(action.stepDelayMs ?? defaults.stepDelayMs);
  }
  return total;
}

async function installCursorOverlay(page, enabled) {
  if (!enabled) return;
  await page.evaluate(() => {
    if (window.__agentOverlay?.installed) return;

    const style = document.createElement("style");
    style.id = "agent-cursor-style";
    style.textContent = `
      #agent-cursor {
        position: fixed;
        left: 0;
        top: 0;
        width: 12px;
        height: 18px;
        transform: translate(-9999px, -9999px);
        pointer-events: none;
        z-index: 2147483647;
        will-change: transform;
        transition: opacity 120ms ease, filter 120ms ease;
        transform-origin: 0 0;
        opacity: 1;
        filter: drop-shadow(0 1px 1px rgba(15, 23, 42, 0.45));
      }
      #agent-cursor svg {
        display: block;
        width: 100%;
        height: 100%;
        transition: transform 80ms ease;
      }
      #agent-cursor.agent-cursor-down {
        filter: drop-shadow(0 1px 2px rgba(15, 23, 42, 0.35));
      }
      #agent-cursor.agent-cursor-down svg {
        transform: translate(1px, 1px) scale(0.96);
      }
      .agent-click-ripple {
        position: fixed;
        width: 18px;
        height: 18px;
        margin-left: -9px;
        margin-top: -9px;
        border-radius: 9999px;
        border: 2px solid rgba(250, 204, 21, 0.95);
        background: rgba(250, 204, 21, 0.35);
        pointer-events: none;
        z-index: 2147483646;
        animation: agentRipple 480ms ease-out forwards;
      }
      @keyframes agentRipple {
        0% { transform: scale(1); opacity: 0.95; }
        100% { transform: scale(4.2); opacity: 0; }
      }
    `;
    document.documentElement.appendChild(style);

    const cursor = document.createElement("div");
    cursor.id = "agent-cursor";
    cursor.innerHTML = `
      <svg viewBox="0 0 16 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
        <path d="M1.2 1.2 L1.2 18.8 L5.9 14.3 L9.2 22.6 L12.2 21.4 L8.9 13.1 L14.9 13.1 Z" fill="rgba(15,23,42,0.28)"/>
        <path d="M1 1 L1 18.2 L5.8 13.8 L9 22 L13 20.4 L9.8 12.2 L15 12.2 Z" fill="#111827"/>
        <path d="M1 1 L1 18.2 L5.8 13.8 L9 22 L13 20.4 L9.8 12.2 L15 12.2 Z" fill="none" stroke="rgba(255,255,255,0.98)" stroke-width="1.3" stroke-linejoin="round"/>
      </svg>
    `;
    document.documentElement.appendChild(cursor);

    const overlay = {
      installed: true,
      x: 24,
      y: 24,
      move(x, y) {
        this.x = Number(x) || 0;
        this.y = Number(y) || 0;
        cursor.style.opacity = "1";
        cursor.style.transform = `translate(${this.x}px, ${this.y}px)`;
      },
      async moveSmooth(x, y, durationMs) {
        const targetX = Number(x) || 0;
        const targetY = Number(y) || 0;
        const duration = Math.max(0, Number(durationMs) || 0);
        if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) {
          this.move(targetX, targetY);
          return;
        }
        if (duration <= 0) {
          this.move(targetX, targetY);
          return;
        }
        const startX = this.x;
        const startY = this.y;
        const startAt = performance.now();
        await new Promise((resolveMove) => {
          const tick = (now) => {
            const t = Math.min(1, (now - startAt) / duration);
            const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            this.move(startX + (targetX - startX) * eased, startY + (targetY - startY) * eased);
            if (t < 1) {
              requestAnimationFrame(tick);
            } else {
              resolveMove();
            }
          };
          requestAnimationFrame(tick);
        });
      },
      click(x, y) {
        const ripple = document.createElement("div");
        ripple.className = "agent-click-ripple";
        ripple.style.left = `${Number(x) || 0}px`;
        ripple.style.top = `${Number(y) || 0}px`;
        document.documentElement.appendChild(ripple);
        setTimeout(() => ripple.remove(), 520);
      },
      setVisible(visible) {
        cursor.style.opacity = visible ? "1" : "0";
      },
      press(down) {
        cursor.classList.toggle("agent-cursor-down", Boolean(down));
      },
    };

    window.__agentOverlay = overlay;
    overlay.move(24, 24);
  });
}

function isOverlayContextError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Execution context was destroyed") ||
    msg.includes("Cannot find context with specified id") ||
    msg.includes("Target closed") ||
    msg.includes("Session closed")
  );
}

async function runOverlayOp(page, enabled, op) {
  if (!enabled) return false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await installCursorOverlay(page, enabled);
      await op();
      return true;
    } catch (err) {
      if (!isOverlayContextError(err) || attempt === 7) return false;
      await delay(120);
    }
  }
  return false;
}

async function ensureCursorReady(page, point, durationMs, enabled) {
  if (!enabled) return true;
  const first = await cursorMove(page, point, durationMs, enabled);
  if (first) return true;
  for (let i = 0; i < 8; i += 1) {
    await delay(100);
    const ok = await cursorMove(page, point, 0, enabled);
    if (ok) return true;
  }
  return false;
}

async function cursorMove(page, point, durationMs, enabled) {
  return await runOverlayOp(page, enabled, async () => {
    await page.evaluate(async (x, y, ms) => {
      if (!window.__agentOverlay?.installed) return;
      await window.__agentOverlay.moveSmooth(x, y, ms);
    }, point.x, point.y, durationMs);
  });
}

async function cursorClickRipple(page, point, enabled) {
  return await runOverlayOp(page, enabled, async () => {
    await page.evaluate((x, y) => {
      window.__agentOverlay?.click(x, y);
    }, point.x, point.y);
  });
}

async function cursorSetVisible(page, visible, enabled) {
  return await runOverlayOp(page, enabled, async () => {
    await page.evaluate((nextVisible) => {
      window.__agentOverlay?.setVisible(Boolean(nextVisible));
    }, visible);
  });
}

async function cursorSetPressed(page, down, enabled) {
  return await runOverlayOp(page, enabled, async () => {
    await page.evaluate((nextDown) => {
      window.__agentOverlay?.press(Boolean(nextDown));
    }, down);
  });
}

async function resolveClickPoint(page, action, timeoutMs) {
  if (action.selector) {
    await page.waitForSelector(action.selector, { timeout: timeoutMs, visible: true });
    const point = await page.$eval(action.selector, (el) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
    return { x: point.x, y: point.y };
  }
  if (action.text) {
    const text = String(action.text).toLowerCase();
    const point = await page.evaluate((needle) => {
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
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, text);
    if (!point) throw new Error(`click text target not found: ${action.text}`);
    return { x: point.x, y: point.y };
  }
  if (Number.isFinite(Number(action.x)) && Number.isFinite(Number(action.y))) {
    return { x: Number(action.x), y: Number(action.y) };
  }
  throw new Error("click requires selector, text, or coordinates");
}

async function humanClick(page, point, action, defaults) {
  const cursorEnabled = Boolean(defaults.cursorOverlay);
  await ensureCursorReady(page, point, Number(action.cursorMoveMs ?? defaults.cursorMoveMs), cursorEnabled);
  await cursorSetVisible(page, true, cursorEnabled);
  const steps = Math.max(1, Number(action.mouseSteps ?? defaults.mouseSteps));
  await page.mouse.move(point.x, point.y, { steps });
  await delay(Number(action.preClickDelayMs ?? defaults.preClickDelayMs));
  await cursorClickRipple(page, point, cursorEnabled);
  await cursorSetPressed(page, true, cursorEnabled);
  await page.mouse.down();
  await delay(Number(action.clickHoldMs ?? defaults.clickHoldMs));
  await page.mouse.up();
  await cursorSetPressed(page, false, cursorEnabled);
  await delay(Number(action.postClickDelayMs ?? defaults.postClickDelayMs));
}

async function humanClickSelector(page, selector, timeoutMs, action, defaults) {
  await page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
  await page.$eval(selector, (el) => {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  });
  await delay(80);
  const point = await page.$eval(selector, (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });
  const cursorEnabled = Boolean(defaults.cursorOverlay);
  await ensureCursorReady(page, point, Number(action.cursorMoveMs ?? defaults.cursorMoveMs), cursorEnabled);
  await cursorSetVisible(page, true, cursorEnabled);
  const steps = Math.max(1, Number(action.mouseSteps ?? defaults.mouseSteps));
  await page.mouse.move(point.x, point.y, { steps });
  await delay(Number(action.preClickDelayMs ?? defaults.preClickDelayMs));
  await cursorClickRipple(page, point, cursorEnabled);
  await cursorSetPressed(page, true, cursorEnabled);
  await page.click(selector, { delay: Number(action.clickHoldMs ?? defaults.clickHoldMs) });
  await cursorSetPressed(page, false, cursorEnabled);
  await delay(Number(action.postClickDelayMs ?? defaults.postClickDelayMs));
}

async function runAction(page, action, defaults) {
  const type = String(action.type).toLowerCase().trim();
  const timeoutMs = Number(action.timeoutMs ?? defaults.defaultTimeoutMs);
  switch (type) {
    case "wait": {
      await cursorSetVisible(page, false, Boolean(defaults.cursorOverlay));
      await delay(Number(action.ms ?? 250));
      return;
    }
    case "wait_for": {
      await cursorSetVisible(page, false, Boolean(defaults.cursorOverlay));
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
        await humanClickSelector(page, action.selector, timeoutMs, action, defaults);
        return;
      }
      const point = await resolveClickPoint(page, action, timeoutMs);
      await humanClick(page, point, action, defaults);
      return;
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
      const point = await page.$eval(action.selector, (el) => {
        const rect = el.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      });
      await cursorMove(page, point, Number(action.cursorMoveMs ?? defaults.cursorMoveMs), Boolean(defaults.cursorOverlay));
      await page.mouse.move(point.x, point.y, { steps: Math.max(2, Number(defaults.mouseSteps)) });
      await delay(Number(action.hoverMs ?? defaults.hoverMs));
      return;
    }
    case "scroll_by": {
      await page.evaluate(
        ({ x, y, behavior }) => {
          window.scrollBy({ left: Number(x || 0), top: Number(y || 0), behavior: behavior || "smooth" });
        },
        { x: action.x ?? 0, y: action.y ?? 0, behavior: action.behavior }
      );
      await delay(Number(action.ms ?? defaults.scrollSettleMs));
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
      await delay(Number(action.ms ?? defaults.scrollSettleMs));
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
      duration: { type: "string" },
      pace: { type: "string", default: "cinematic" },
      "cursor-overlay": { type: "string", default: "true" },
      "debug-port": { type: "string" },
      chrome: { type: "string" },
      build: { type: "string", default: "false" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(`Usage:
  node scripts/agent-proof-live.mjs --spec ./live-spec.json
  node scripts/agent-proof-live.mjs --url https://example.com --actions @./actions.json --pace cinematic
`);
    return;
  }

  const spec = await loadSpec(values.spec);
  const url = pick(values.url, spec.url);
  if (!url) throw new Error("Missing url");
  const actions = await loadActions(values.actions, spec.actions);

  const profileName = String(pick(values.profile, spec.profile, "efficient")).toLowerCase();
  const profile = CAPTURE_PROFILES[profileName];
  if (!profile) throw new Error(`Unsupported profile "${profileName}"`);
  const pace = parsePace(pick(values.pace, spec.pace, "cinematic"));
  const actionConfig = mergeActionConfig(spec.actionConfig, pace);
  const cursorOverlay = boolArg(pick(values["cursor-overlay"], spec.cursorOverlay, "true"), true);
  actionConfig.cursorOverlay = cursorOverlay;

  const mode = String(pick(values.mode, spec.mode, "after")).toLowerCase() === "before" ? "before" : "after";
  const name = String(pick(values.name, spec.name, "live-proof")).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const rawDuration = pick(values.duration, spec.duration);
  const estimatedDuration = Math.ceil(estimateDurationMs(actions, actionConfig) / 1000) + 2;
  const duration = parseIntegerArg("duration", rawDuration ?? String(Math.max(10, estimatedDuration)), { min: 1, max: 7200 });
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
  const rawPort = pick(values["debug-port"], spec.debugPort, "0");
  const parsedPort = parseIntegerArg("debug-port", rawPort, { min: 0, max: 65535 });
  const port = parsedPort === 0 ? await findFreePort() : parsedPort;
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
    await installCursorOverlay(page, cursorOverlay);

    const pageWsEndpoint = await pageWsEndpointForUrl(port, page.url());
    const recorderArgs = [
      "./scripts/agent-capture.mjs",
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
    await page.mouse.move(24, 24, { steps: 1 });
    await cursorMove(page, { x: 24, y: 24 }, 0, cursorOverlay);

    await runActions(page, actions, actionConfig);
    await waitForChild(recorder);

    const sidecarPath = `${output}.proof.json`;
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    sidecar.controlMode = "puppeteer-live";
    sidecar.pace = pace;
    sidecar.cursorOverlay = cursorOverlay;
    sidecar.estimatedDurationSec = estimatedDuration;
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
