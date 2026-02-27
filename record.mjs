#!/usr/bin/env node
/**
 * Agent Video Recorder
 * 
 * Records a headless Chrome tab to MP4 using CDP Page.startScreencast + FFmpeg.
 * Built for agent QA — before/after video capture of web UIs.
 *
 * Usage:
 *   record.mjs --url <url> --output <file.mp4> [--duration <seconds>] [--width <px>] [--height <px>] [--script <js-file>]
 *
 * Options:
 *   --url        URL to navigate to
 *   --output     Output MP4 path
 *   --duration   Recording duration in seconds (default: 10)
 *   --width      Viewport width (default: 1280)
 *   --height     Viewport height (default: 720)
 *   --fps        Target FPS (default: 10, keeps files small)
 *   --script     Optional JS file to execute during recording (for interactions)
 *   --chrome     Path to Chrome/Chromium binary
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    url:      { type: 'string' },
    output:   { type: 'string', default: 'recording.mp4' },
    duration: { type: 'string', default: '10' },
    width:    { type: 'string', default: '1280' },
    height:   { type: 'string', default: '720' },
    fps:      { type: 'string', default: '10' },
    script:   { type: 'string' },
    chrome:   { type: 'string', default: '/usr/bin/chromium' },
  },
});

if (!args.url) {
  console.error('Usage: record.mjs --url <url> --output <file.mp4> [--duration <s>]');
  process.exit(1);
}

const WIDTH = parseInt(args.width);
const HEIGHT = parseInt(args.height);
const DURATION = parseInt(args.duration);
const FPS = parseInt(args.fps);

console.log(`Recording ${args.url} → ${args.output} (${WIDTH}x${HEIGHT}, ${DURATION}s, ${FPS}fps)`);

const browser = await puppeteer.launch({
  executablePath: args.chrome,
  headless: 'new',
  args: [
    `--window-size=${WIDTH},${HEIGHT}`,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT });

// Start FFmpeg — receives raw JPEG frames via stdin, outputs MP4
const ffmpeg = spawn('ffmpeg', [
  '-y',
  '-f', 'image2pipe',
  '-framerate', String(FPS),
  '-i', '-',
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-preset', 'fast',
  '-crf', '23',
  '-movflags', '+faststart',
  args.output,
], { stdio: ['pipe', 'pipe', 'pipe'] });

ffmpeg.stderr.on('data', (d) => {
  const msg = d.toString();
  if (msg.includes('Error') || msg.includes('error')) console.error('[ffmpeg]', msg.trim());
});

let frameCount = 0;

// Use CDP screencast
const cdp = await page.createCDPSession();
cdp.on('Page.screencastFrame', async (event) => {
  frameCount++;
  const buf = Buffer.from(event.data, 'base64');
  if (!ffmpeg.stdin.destroyed) {
    ffmpeg.stdin.write(buf);
  }
  try {
    await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
  } catch {}
});

// Navigate first, then start recording
await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });
console.log('Page loaded, starting screencast...');

await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 80,
  maxWidth: WIDTH,
  maxHeight: HEIGHT,
  everyNthFrame: 1,
});

// If a script is provided, run it (for simulating interactions)
if (args.script) {
  const scriptContent = await readFile(args.script, 'utf-8');
  page.evaluate(scriptContent).catch(e => console.error('[script]', e.message));
}

// Force frame generation by triggering repaints periodically
const forceFrames = setInterval(async () => {
  try {
    await page.evaluate(() => {
      // Trigger a minor repaint
      document.body.style.opacity = document.body.style.opacity === '0.999' ? '1' : '0.999';
    });
  } catch {}
}, 1000 / FPS);

// Record for specified duration
await new Promise(r => setTimeout(r, DURATION * 1000));
clearInterval(forceFrames);

// Stop
await cdp.send('Page.stopScreencast');
console.log(`Captured ${frameCount} frames`);

ffmpeg.stdin.end();
await new Promise((resolve, reject) => {
  ffmpeg.on('close', (code) => {
    if (code === 0) {
      console.log(`✓ Saved to ${args.output}`);
      resolve();
    } else {
      reject(new Error(`FFmpeg exited with code ${code}`));
    }
  });
});

await browser.close();
