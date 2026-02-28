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
 *   --ffmpeg     FFmpeg binary path (default: ffmpeg)
 *   --encoder    auto|libx264|h264_videotoolbox|h264_nvenc|h264_vaapi|h264_qsv
 *   --video-bitrate, --maxrate, --bufsize   Optional encoder rate control values
 *   --jpeg-quality Screencast JPEG quality (1-100, default: 90)
 */

import puppeteer from 'puppeteer-core';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { once } from 'events';
import { parseArgs } from 'util';

const ENCODER_CHOICES = new Set([
  'auto',
  'libx264',
  'h264_videotoolbox',
  'h264_nvenc',
  'h264_vaapi',
  'h264_qsv',
]);

function parseIntegerArg(name, rawValue, { min, max }) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}. Received "${rawValue}".`);
  }
  return parsed;
}

function parseEncoderArg(rawValue) {
  const normalized = String(rawValue ?? '').trim().toLowerCase();
  if (!ENCODER_CHOICES.has(normalized)) {
    throw new Error(`--encoder must be one of: ${Array.from(ENCODER_CHOICES).join(', ')}`);
  }
  return normalized;
}

function parseBitrateToKbps(value) {
  const match = String(value ?? '').trim().toLowerCase().match(/^(\d+)([kmg]?)$/);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'm') return amount * 1000;
  if (unit === 'g') return amount * 1000 * 1000;
  return amount;
}

function formatKbps(kbps) {
  return `${Math.max(1, Math.round(kbps))}k`;
}

function defaultBitrateKbps(width, height, fps) {
  const pixelsPerSecond = width * height * fps;
  if (pixelsPerSecond <= 3_000_000) return 1200;
  if (pixelsPerSecond <= 14_000_000) return 3000;
  if (pixelsPerSecond <= 40_000_000) return 8000;
  return 12000;
}

function resolveRateControl(width, height, fps, args) {
  const bitrate = args['video-bitrate']?.trim() || formatKbps(defaultBitrateKbps(width, height, fps));
  const parsedKbps = parseBitrateToKbps(bitrate);
  if (parsedKbps === null) {
    return {
      bitrate,
      maxrate: args.maxrate?.trim() || bitrate,
      bufsize: args.bufsize?.trim() || bitrate,
    };
  }
  return {
    bitrate,
    maxrate: args.maxrate?.trim() || formatKbps(parsedKbps * 1.5),
    bufsize: args.bufsize?.trim() || formatKbps(parsedKbps * 2),
  };
}

function buildFfmpegArgs({ fps, output, encoder, rateControl, vaapiDevice }) {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', '-',
  ];

  const gop = String(Math.max(1, Math.round(fps * 2)));

  if (encoder === 'h264_videotoolbox') {
    args.push(
      '-c:v', 'h264_videotoolbox',
      '-profile:v', 'high',
      '-realtime', 'true',
      '-b:v', rateControl.bitrate,
      '-maxrate', rateControl.maxrate,
      '-bufsize', rateControl.bufsize,
      '-g', gop,
      '-pix_fmt', 'yuv420p',
    );
  } else if (encoder === 'h264_nvenc') {
    args.push(
      '-c:v', 'h264_nvenc',
      '-preset', 'p5',
      '-b:v', rateControl.bitrate,
      '-maxrate', rateControl.maxrate,
      '-bufsize', rateControl.bufsize,
      '-g', gop,
      '-pix_fmt', 'yuv420p',
    );
  } else if (encoder === 'h264_vaapi') {
    args.push(
      '-vaapi_device', vaapiDevice,
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi',
      '-profile:v', 'high',
      '-b:v', rateControl.bitrate,
      '-maxrate', rateControl.maxrate,
      '-bufsize', rateControl.bufsize,
      '-g', gop,
      '-pix_fmt', 'yuv420p',
    );
  } else if (encoder === 'h264_qsv') {
    args.push(
      '-c:v', 'h264_qsv',
      '-b:v', rateControl.bitrate,
      '-maxrate', rateControl.maxrate,
      '-bufsize', rateControl.bufsize,
      '-g', gop,
      '-pix_fmt', 'yuv420p',
    );
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-g', gop,
      '-pix_fmt', 'yuv420p',
    );
  }

  args.push('-movflags', '+faststart', output);
  return args;
}

async function readFfmpegEncoders(ffmpegBinary) {
  return await new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(ffmpegBinary, ['-hide_banner', '-encoders'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('close', () => resolve(output.toLowerCase()));
  });
}

async function resolveEncoder(requested, ffmpegBinary) {
  if (requested !== 'auto') return requested;

  let encodersText = '';
  try {
    encodersText = await readFfmpegEncoders(ffmpegBinary);
  } catch {
    return 'libx264';
  }

  const available = (name) => encodersText.includes(name);
  const ordered = process.platform === 'darwin'
    ? ['h264_videotoolbox', 'libx264']
    : ['h264_nvenc', 'h264_vaapi', 'h264_qsv', 'libx264'];

  for (const candidate of ordered) {
    if (candidate === 'libx264' || available(candidate)) {
      return candidate;
    }
  }
  return 'libx264';
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Recording aborted.'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createFfmpegExitPromise(ffmpeg) {
  return new Promise((resolve, reject) => {
    ffmpeg.once('error', (err) => reject(new Error(`Failed to start FFmpeg: ${err.message}`)));
    ffmpeg.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`FFmpeg exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`));
    });
  });
}

async function writeFrameWithBackpressure(ffmpeg, frameBuffer) {
  const stdin = ffmpeg.stdin;
  if (!stdin || stdin.destroyed || stdin.writableEnded) return false;

  if (stdin.write(frameBuffer)) return true;

  await Promise.race([
    once(stdin, 'drain'),
    once(stdin, 'error').then(([err]) => {
      throw err;
    }),
    once(ffmpeg, 'close').then(([code, signal]) => {
      throw new Error(`FFmpeg exited while draining stdin (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`);
    }),
  ]);

  return true;
}

async function main() {
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
      ffmpeg:   { type: 'string', default: 'ffmpeg' },
      encoder:  { type: 'string', default: 'auto' },
      'video-bitrate': { type: 'string' },
      maxrate:  { type: 'string' },
      bufsize:  { type: 'string' },
      'vaapi-device': { type: 'string', default: '/dev/dri/renderD128' },
      'jpeg-quality': { type: 'string', default: '90' },
    },
  });

  if (!args.url) {
    throw new Error('Usage: record.mjs --url <url> --output <file.mp4> [--duration <s>]');
  }

  if (!args.output?.trim()) {
    throw new Error('--output must be a non-empty path.');
  }

  const width = parseIntegerArg('width', args.width, { min: 16, max: 7680 });
  const height = parseIntegerArg('height', args.height, { min: 16, max: 4320 });
  const duration = parseIntegerArg('duration', args.duration, { min: 1, max: 7200 });
  const fps = parseIntegerArg('fps', args.fps, { min: 1, max: 60 });
  const jpegQuality = parseIntegerArg('jpeg-quality', args['jpeg-quality'], { min: 1, max: 100 });
  const requestedEncoder = parseEncoderArg(args.encoder);
  const selectedEncoder = await resolveEncoder(requestedEncoder, args.ffmpeg);
  const rateControl = resolveRateControl(width, height, fps, args);

  const abortController = new AbortController();
  const onSigint = () => {
    if (!abortController.signal.aborted) {
      console.warn('\n[recorder] SIGINT received, stopping early...');
      abortController.abort(new Error('Interrupted by SIGINT.'));
    }
  };
  const onSigterm = () => {
    if (!abortController.signal.aborted) {
      console.warn('\n[recorder] SIGTERM received, stopping early...');
      abortController.abort(new Error('Interrupted by SIGTERM.'));
    }
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let browser;
  let cdp;
  let ffmpeg;
  let ffmpegExitPromise;
  let forceFrames;
  let frameChain = Promise.resolve();
  let frameCount = 0;
  let frameWriteFailures = 0;
  let screencastStarted = false;
  let mainError;

  console.log(`Recording ${args.url} → ${args.output} (${width}x${height}, ${duration}s, ${fps}fps, ${selectedEncoder})`);

  try {
    browser = await puppeteer.launch({
      executablePath: args.chrome,
      headless: 'new',
      args: [
        `--window-size=${width},${height}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width, height });

    ffmpeg = spawn(
      args.ffmpeg,
      buildFfmpegArgs({
        fps,
        output: args.output,
        encoder: selectedEncoder,
        rateControl,
        vaapiDevice: args['vaapi-device'],
      }),
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );

    ffmpegExitPromise = createFfmpegExitPromise(ffmpeg);
    ffmpeg.stderr.on('data', (chunk) => {
      const msg = chunk.toString();
      if (msg.toLowerCase().includes('error')) console.error('[ffmpeg]', msg.trim());
    });

    cdp = await page.createCDPSession();
    cdp.on('Page.screencastFrame', (event) => {
      frameChain = frameChain
        .then(async () => {
          frameCount++;
          const frameBuffer = Buffer.from(event.data, 'base64');
          try {
            const wrote = await writeFrameWithBackpressure(ffmpeg, frameBuffer);
            if (!wrote) frameWriteFailures++;
          } catch (err) {
            frameWriteFailures++;
            if (!abortController.signal.aborted) {
              const message = err instanceof Error ? err.message : String(err);
              abortController.abort(new Error(`Failed writing frame to FFmpeg: ${message}`));
            }
          }
        })
        .catch((err) => {
          frameWriteFailures++;
          if (!abortController.signal.aborted) {
            const message = err instanceof Error ? err.message : String(err);
            abortController.abort(new Error(`Frame handler failed: ${message}`));
          }
        })
        .finally(async () => {
          try {
            await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
          } catch {}
        });
    });

    await page.goto(args.url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('Page loaded, starting screencast...');

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: jpegQuality,
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
    screencastStarted = true;

    if (args.script) {
      const scriptContent = await readFile(args.script, 'utf-8');
      page.evaluate(scriptContent).catch((err) => {
        console.error('[script]', err instanceof Error ? err.message : String(err));
      });
    }

    forceFrames = setInterval(() => {
      page.evaluate(() => {
        // Trigger a minor repaint so mostly-static pages keep emitting frames.
        document.body.style.opacity = document.body.style.opacity === '0.999' ? '1' : '0.999';
      }).catch(() => {});
    }, Math.max(1, Math.floor(1000 / fps)));

    await delay(duration * 1000, abortController.signal);
  } catch (err) {
    mainError = err;
  }

  if (forceFrames) clearInterval(forceFrames);

  if (cdp && screencastStarted) {
    try {
      await cdp.send('Page.stopScreencast');
    } catch {}
  }

  await frameChain.catch(() => {});
  console.log(`Captured ${frameCount} frames${frameWriteFailures ? ` (${frameWriteFailures} write failures)` : ''}`);

  if (ffmpeg?.stdin && !ffmpeg.stdin.destroyed && !ffmpeg.stdin.writableEnded) {
    ffmpeg.stdin.end();
  }

  let ffmpegError;
  if (ffmpegExitPromise) {
    try {
      await ffmpegExitPromise;
      if (!mainError) {
        console.log(`✓ Saved to ${args.output}`);
      }
    } catch (err) {
      ffmpegError = err;
    }
  }

  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      if (!mainError) mainError = err;
    }
  }

  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);

  if (!mainError && ffmpegError) {
    mainError = ffmpegError;
  }

  if (mainError) {
    throw mainError;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[recorder] ${message}`);
  process.exitCode = 1;
});
