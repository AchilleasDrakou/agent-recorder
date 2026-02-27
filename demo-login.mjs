#!/usr/bin/env node
/**
 * Demo: Record login + dashboard navigation of Command Center
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';

const URL = 'http://localhost:3001';
const OUTPUT = '/tmp/cc-login-demo.mp4';
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 10;
const PASSWORD = 'command-center-2026';

console.log(`Recording ${URL} → ${OUTPUT}`);

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`],
});

const page = await browser.newPage();
await page.setViewport({ width: WIDTH, height: HEIGHT });

// Start FFmpeg
const ffmpeg = spawn('ffmpeg', [
  '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '23',
  '-movflags', '+faststart', OUTPUT,
], { stdio: ['pipe', 'pipe', 'pipe'] });

ffmpeg.stderr.on('data', (d) => {
  const msg = d.toString();
  if (msg.includes('Error')) console.error('[ffmpeg]', msg.trim());
});

let frameCount = 0;
const cdp = await page.createCDPSession();
cdp.on('Page.screencastFrame', async (event) => {
  frameCount++;
  const buf = Buffer.from(event.data, 'base64');
  if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.write(buf);
  try { await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }); } catch {}
});

// Force frames
const forceFrames = setInterval(async () => {
  try { await page.evaluate(() => { document.body.style.opacity = document.body.style.opacity === '0.999' ? '1' : '0.999'; }); } catch {}
}, 1000 / FPS);

// Start screencast
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });

// Navigate to login page
await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
console.log('On login page...');
await new Promise(r => setTimeout(r, 2000));

// Type password
const passwordInput = await page.waitForSelector('input[type="password"]');
await passwordInput.type(PASSWORD, { delay: 80 });
await new Promise(r => setTimeout(r, 1000));

// Click submit
await page.click('button[type="submit"]');
console.log('Submitted login...');
await new Promise(r => setTimeout(r, 3000));

// Wait for dashboard to load
await page.waitForSelector('body', { timeout: 10000 });
console.log('Dashboard loaded...');
await new Promise(r => setTimeout(r, 3000));

// Scroll down to show more content
await page.evaluate(() => window.scrollBy(0, 300));
await new Promise(r => setTimeout(r, 2000));

// Scroll back up
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise(r => setTimeout(r, 2000));

// Stop
clearInterval(forceFrames);
await cdp.send('Page.stopScreencast');
console.log(`Captured ${frameCount} frames`);

ffmpeg.stdin.end();
await new Promise((resolve, reject) => {
  ffmpeg.on('close', (code) => {
    if (code === 0) { console.log(`✓ Saved to ${OUTPUT}`); resolve(); }
    else reject(new Error(`FFmpeg exited with code ${code}`));
  });
});

await browser.close();
