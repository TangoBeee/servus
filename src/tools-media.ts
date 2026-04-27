/**
 * Media tools — video downloading, audio/video conversion, and media management.
 *
 * Wraps commonly-available CLI tools (yt-dlp, ffmpeg) with
 * safe defaults and structured output.
 */

import { tool } from "ai";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { registerChild, unregisterChild } from "./child-registry.js";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext } from "./engine.js";

const execFileAsync = promisify(execFile);

// ─── Schemas ────────────────────────────────────────────────────────────────

const downloadVideoSchema = z.object({
  url: z.string().describe("URL of the video to download (YouTube, Vimeo, etc.)"),
  outputDir: z.string().optional().describe("Directory to save the video (default: ~/Downloads)"),
  format: z.enum(["best", "mp4", "mp3", "audio"]).optional().describe("Format: 'best' (default), 'mp4', 'mp3' (audio only), 'audio' (best audio)"),
  quality: z.string().optional().describe("Quality preference: '720', '1080', '4k', or 'best' (default)"),
});

const convertMediaSchema = z.object({
  input: z.string().describe("Path to the input media file"),
  output: z.string().describe("Path for the output file (extension determines format)"),
  options: z.string().optional().describe("Additional ffmpeg options (e.g. '-ss 00:01:00 -t 30' to trim)"),
  overwrite: z.boolean().optional().describe("Allow overwriting an existing output file."),
});

const mediaInfoSchema = z.object({
  path: z.string().describe("Path to the media file to inspect"),
});

const videoInfoSchema = z.object({
  url: z.string().describe("URL to get video information from (without downloading)"),
});

const trimMediaSchema = z.object({
  input: z.string(),
  output: z.string(),
  start: z.string().describe("Start timestamp, e.g. 00:01:30 or 90"),
  duration: z.string().optional().describe("Duration, e.g. 30 or 00:00:30"),
  overwrite: z.boolean().optional(),
});

const compressMediaSchema = z.object({
  input: z.string(),
  output: z.string(),
  crf: z.number().int().min(0).max(51).optional().describe("Video CRF, lower is higher quality. Default 28."),
  preset: z.string().optional().describe("ffmpeg preset. Default medium."),
  videoBitrate: z.string().optional().describe("Optional target video bitrate, e.g. 1500k."),
  audioBitrate: z.string().optional().describe("Optional target audio bitrate, e.g. 128k."),
  overwrite: z.boolean().optional(),
});

const extractAudioSchema = z.object({
  input: z.string(),
  output: z.string().optional().describe("Output audio path. Defaults beside input."),
  format: z.enum(["mp3", "m4a", "wav", "flac"]).optional(),
  overwrite: z.boolean().optional(),
});

const thumbnailSchema = z.object({
  input: z.string(),
  output: z.string(),
  time: z.string().optional().describe("Timestamp for thumbnail. Default 00:00:01."),
  overwrite: z.boolean().optional(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function resolveMediaPath(cwd: string, path: string): string {
  if (path === "~") return process.env.HOME ?? cwd;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? cwd, path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.startsWith("..") || rel === ".." || isAbsolute(rel);
}

async function guardMediaWrite(
  ctx: Pick<EngineContext, "cwd" | "onConsent">,
  action: string,
  outputPath: string,
  overwrite?: boolean,
): Promise<string | null> {
  if (existsSync(outputPath) && !overwrite) {
    return `Error: output exists — ${outputPath}. Set overwrite=true to replace it.`;
  }

  if (!existsSync(outputPath) && !isOutside(ctx.cwd, outputPath)) return null;

  const detail = [
    `Output: ${outputPath}`,
    existsSync(outputPath) ? "This will overwrite an existing file." : "",
    isOutside(ctx.cwd, outputPath) ? `This writes outside the working directory: ${ctx.cwd}` : "",
  ].filter(Boolean).join("\n");
  const assessed = assessRisk(`${action}\n${detail}`);
  const risk = isOutside(ctx.cwd, outputPath) || existsSync(outputPath)
    ? "high"
    : assessed.risk === "low" ? "medium" : assessed.risk;
  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({ action, detail, risk, engine: "media" });
  return approved ? null : `Action blocked by consent gate: ${action}`;
}

async function requireCommand(command: string): Promise<string | null> {
  return await commandExists(command)
    ? null
    : `Error: ${command} is not installed. Install it with: brew install ${command}`;
}

function runCommandCapture(command: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) registerChild(child.pid, {});

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      rej(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timeout);
      if (child.pid) unregisterChild(child.pid);
      rej(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (child.pid) unregisterChild(child.pid);
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");
      if (code === 0) res(stdout || stderr);
      else rej(new Error(`${command} failed with exit ${code}:\n${(stderr || stdout).slice(0, 4000)}`));
    });
  });
}

function splitArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function mediaOutputSummary(action: string, path: string): string {
  const size = existsSync(path) ? ` (${formatFileSize(statSync(path).size)})` : "";
  return `${action}: ${path}${size}\nArtifact: ${path}`;
}

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function createMediaTools(cwd: string) {
  return createMediaToolsWithContext({ cwd });
}

export function createMediaToolsWithContext(ctx: Pick<EngineContext, "cwd" | "onConsent">) {
  const cwd = ctx.cwd;
  const home = process.env.HOME ?? "/tmp";
  const defaultDownloadDir = resolve(home, "Downloads");

  return {
    media_readiness: tool({
      description: "Report local media tooling readiness for yt-dlp, ffmpeg, and ffprobe.",
      inputSchema: z.object({}),
      execute: async () => {
        const [hasYtdlp, hasFfmpeg, hasFfprobe] = await Promise.all([
          commandExists("yt-dlp"),
          commandExists("ffmpeg"),
          commandExists("ffprobe"),
        ]);
        const missing = [
          !hasYtdlp ? "yt-dlp" : "",
          !hasFfmpeg ? "ffmpeg" : "",
          !hasFfprobe ? "ffprobe" : "",
        ].filter(Boolean);
        return [
          `Media readiness: ${missing.length ? "degraded" : "ready"}`,
          `yt-dlp: ${hasYtdlp ? "ok" : "missing"}`,
          `ffmpeg: ${hasFfmpeg ? "ok" : "missing"}`,
          `ffprobe: ${hasFfprobe ? "ok" : "missing"}`,
          missing.length ? `Install: brew install ${missing.join(" ")}` : "",
        ].filter(Boolean).join("\n");
      },
    }),

    download_video: tool({
      description: [
        "Download a video from YouTube, Vimeo, or other supported platforms using yt-dlp.",
        "Supports quality selection and format conversion (mp4, mp3, audio-only).",
        "Requires yt-dlp to be installed (`brew install yt-dlp` or `pip install yt-dlp`).",
      ].join("\n"),
      inputSchema: downloadVideoSchema,
      execute: async (input: z.infer<typeof downloadVideoSchema>) => {
        const hasYtdlp = await commandExists("yt-dlp");
        if (!hasYtdlp) {
          return "Error: yt-dlp is not installed. Install it with: brew install yt-dlp (or pip install yt-dlp)";
        }

        const outDir = input.outputDir ? resolveMediaPath(cwd, input.outputDir) : defaultDownloadDir;
        mkdirSync(outDir, { recursive: true });
        const outputTemplate = resolve(outDir, "%(title)s.%(ext)s");

        const args: string[] = ["-o", outputTemplate, "--no-playlist", "--restrict-filenames"];

        switch (input.format) {
          case "mp3":
            args.push("-x", "--audio-format", "mp3");
            break;
          case "audio":
            args.push("-x", "--audio-format", "best");
            break;
          case "mp4":
            args.push("--merge-output-format", "mp4");
            if (input.quality && input.quality !== "best") {
              args.push("-f", `bestvideo[height<=${input.quality}]+bestaudio/best[height<=${input.quality}]`);
            }
            break;
          default:
            if (input.quality && input.quality !== "best") {
              args.push("-f", `bestvideo[height<=${input.quality}]+bestaudio/best`);
            }
        }

        args.push(input.url);

        return new Promise<string>((res) => {
          const child = spawn("yt-dlp", args, {
            cwd: outDir,
            env: { ...process.env, FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
          });

          if (child.pid) registerChild(child.pid, {});

          const chunks: Buffer[] = [];
          const errChunks: Buffer[] = [];
          child.stdout?.on("data", (d: Buffer) => chunks.push(d));
          child.stderr?.on("data", (d: Buffer) => errChunks.push(d));

          const timeout = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* */ }
            res("Error: download timed out after 5 minutes");
          }, 300_000); // 5 min timeout

          child.on("close", (code) => {
            clearTimeout(timeout);
            if (child.pid) unregisterChild(child.pid);

            const stdout = Buffer.concat(chunks).toString("utf-8");
            const stderr = Buffer.concat(errChunks).toString("utf-8");

            if (code === 0) {
              // Try to find the downloaded file path from stdout
              const destMatch = stdout.match(/Destination:\s*(.+)/);
              const mergeMatch = stdout.match(/Merging formats into "(.+)"/);
              const alreadyMatch = stdout.match(/has already been downloaded/);

              const filePath = mergeMatch?.[1] ?? destMatch?.[1] ?? "unknown";

              if (alreadyMatch) {
                res("Video was already downloaded: " + filePath);
              } else {
                // Get file size
                let sizeInfo = "";
                try {
                  const st = statSync(filePath);
                  sizeInfo = " (" + formatFileSize(st.size) + ")";
                } catch { /* ignore */ }
                res("Downloaded successfully: " + filePath + sizeInfo);
              }
            } else {
              res("Download failed (exit " + code + "):\n" + (stderr || stdout).slice(0, 2000));
            }
          });
        });
      },
    }),

    convert_media: tool({
      description: [
        "Convert audio/video files using ffmpeg.",
        "Output format is determined by the file extension.",
        "Supports trimming, re-encoding, format conversion, and more.",
        "Requires ffmpeg to be installed.",
      ].join("\n"),
      inputSchema: convertMediaSchema,
      execute: async (input: z.infer<typeof convertMediaSchema>) => {
        const hasFfmpeg = await commandExists("ffmpeg");
        if (!hasFfmpeg) {
          return "Error: ffmpeg is not installed. Install it with: brew install ffmpeg";
        }

        const inputPath = resolveMediaPath(cwd, input.input);
        if (!existsSync(inputPath)) {
          return "Error: input file not found — " + inputPath;
        }

        const outputPath = resolveMediaPath(cwd, input.output);
        const blocked = await guardMediaWrite(ctx, "convert_media", outputPath, input.overwrite);
        if (blocked) return blocked;

        try {
          mkdirSync(dirname(outputPath), { recursive: true });
          const args = [
            input.overwrite ? "-y" : "-n",
            "-i", inputPath,
            ...splitArgs(input.options ?? ""),
            outputPath,
          ];
          const stdout = await runCommandCapture("ffmpeg", args, cwd, 300_000);
          if (existsSync(outputPath)) {
            const st = statSync(outputPath);
            return "Converted successfully: " + outputPath + " (" + formatFileSize(st.size) + ")\nArtifact: " + outputPath;
          }
          return "Conversion may have succeeded but output file not found at " + outputPath + "\n\n" + stdout.slice(-500);
        } catch (err: unknown) {
          return "Conversion failed:\n" + ((err as Error).message ?? "Unknown error").slice(0, 2000);
        }
      },
    }),

    media_info: tool({
      description: "Get detailed info about a local media file (duration, codec, resolution, bitrate, etc.) using ffprobe.",
      inputSchema: mediaInfoSchema,
      execute: async (input: z.infer<typeof mediaInfoSchema>) => {
        const filePath = resolveMediaPath(cwd, input.path);
        if (!existsSync(filePath)) {
          return "Error: file not found — " + filePath;
        }

        const hasFfprobe = await commandExists("ffprobe");
        if (!hasFfprobe) {
          // Fallback to basic file info
          const st = statSync(filePath);
          return "File: " + basename(filePath) + "\nSize: " + formatFileSize(st.size) + "\n(ffprobe not installed for detailed info)";
        }

        try {
          const { stdout } = await execFileAsync(
            "ffprobe",
            ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
            { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
          );
          const info = JSON.parse(stdout);

          const lines: string[] = ["File: " + basename(filePath)];

          if (info.format) {
            lines.push("Format: " + (info.format.format_long_name ?? info.format.format_name));
            if (info.format.duration) lines.push("Duration: " + parseFloat(info.format.duration).toFixed(1) + "s");
            if (info.format.size) lines.push("Size: " + formatFileSize(parseInt(info.format.size)));
            if (info.format.bit_rate) lines.push("Bitrate: " + (parseInt(info.format.bit_rate) / 1000).toFixed(0) + " kbps");
          }

          if (info.streams) {
            for (const stream of info.streams) {
              if (stream.codec_type === "video") {
                lines.push("Video: " + stream.codec_name + " " + stream.width + "x" + stream.height +
                  (stream.r_frame_rate ? " @ " + stream.r_frame_rate + " fps" : ""));
              } else if (stream.codec_type === "audio") {
                lines.push("Audio: " + stream.codec_name +
                  (stream.sample_rate ? " " + stream.sample_rate + "Hz" : "") +
                  (stream.channels ? " " + stream.channels + "ch" : ""));
              }
            }
          }

          return lines.join("\n");
        } catch (err: unknown) {
          return "Error getting media info: " + (err instanceof Error ? err.message : String(err));
        }
      },
    }),

    video_info: tool({
      description: "Get information about an online video (title, duration, formats) without downloading it. Uses yt-dlp.",
      inputSchema: videoInfoSchema,
      execute: async (input: z.infer<typeof videoInfoSchema>) => {
        const hasYtdlp = await commandExists("yt-dlp");
        if (!hasYtdlp) {
          return "Error: yt-dlp is not installed. Install it with: brew install yt-dlp";
        }

        try {
          const { stdout } = await execFileAsync(
            "yt-dlp",
            ["--dump-json", "--no-playlist", input.url],
            { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
          );
          const info = JSON.parse(stdout);

          const lines: string[] = [];
          if (info.title) lines.push("Title: " + info.title);
          if (info.uploader) lines.push("Creator: " + info.uploader);
          if (info.duration) {
            const mins = Math.floor(info.duration / 60);
            const secs = info.duration % 60;
            lines.push("Duration: " + mins + "m " + secs + "s");
          }
          if (info.view_count) lines.push("Views: " + info.view_count.toLocaleString());
          if (info.upload_date) {
            const d = info.upload_date;
            lines.push("Uploaded: " + d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8));
          }
          if (info.description) {
            lines.push("Description: " + info.description.slice(0, 300) + (info.description.length > 300 ? "…" : ""));
          }
          if (info.formats) {
            const formats = info.formats
              .filter((f: { height?: number }) => f.height)
              .map((f: { height: number; ext: string; filesize?: number }) =>
                f.height + "p " + f.ext + (f.filesize ? " (" + formatFileSize(f.filesize) + ")" : ""),
              )
              .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
              .slice(0, 8);
            if (formats.length > 0) lines.push("Formats: " + formats.join(", "));
          }

          return lines.join("\n");
        } catch (err: unknown) {
          return "Error getting video info: " + (err instanceof Error ? err.message : String(err));
        }
      },
    }),

    trim_media: tool({
      description: "Trim a local audio/video file to a time range using ffmpeg.",
      inputSchema: trimMediaSchema,
      execute: async (input: z.infer<typeof trimMediaSchema>) => {
        const inputPath = resolveMediaPath(cwd, input.input);
        const outputPath = resolveMediaPath(cwd, input.output);
        const ready = await requireCommand("ffmpeg");
        if (ready) return ready;
        if (!existsSync(inputPath)) return "Error: input file not found — " + inputPath;
        const blocked = await guardMediaWrite(ctx, "trim_media", outputPath, input.overwrite);
        if (blocked) return blocked;
        mkdirSync(dirname(outputPath), { recursive: true });
        const args = [input.overwrite ? "-y" : "-n", "-ss", input.start, "-i", inputPath];
        if (input.duration) args.push("-t", input.duration);
        args.push("-c", "copy", outputPath);
        await runCommandCapture("ffmpeg", args, cwd, 300_000);
        return mediaOutputSummary("Trimmed media", outputPath);
      },
    }),

    compress_media: tool({
      description: "Compress/re-encode a local video using ffmpeg CRF or bitrate settings.",
      inputSchema: compressMediaSchema,
      execute: async (input: z.infer<typeof compressMediaSchema>) => {
        const inputPath = resolveMediaPath(cwd, input.input);
        const outputPath = resolveMediaPath(cwd, input.output);
        const ready = await requireCommand("ffmpeg");
        if (ready) return ready;
        if (!existsSync(inputPath)) return "Error: input file not found — " + inputPath;
        const blocked = await guardMediaWrite(ctx, "compress_media", outputPath, input.overwrite);
        if (blocked) return blocked;
        mkdirSync(dirname(outputPath), { recursive: true });
        const args = [input.overwrite ? "-y" : "-n", "-i", inputPath];
        if (input.videoBitrate) args.push("-b:v", input.videoBitrate);
        else args.push("-crf", String(input.crf ?? 28), "-preset", input.preset ?? "medium");
        if (input.audioBitrate) args.push("-b:a", input.audioBitrate);
        args.push(outputPath);
        await runCommandCapture("ffmpeg", args, cwd, 300_000);
        return mediaOutputSummary("Compressed media", outputPath);
      },
    }),

    extract_audio: tool({
      description: "Extract audio from a local video file.",
      inputSchema: extractAudioSchema,
      execute: async (input: z.infer<typeof extractAudioSchema>) => {
        const inputPath = resolveMediaPath(cwd, input.input);
        const format = input.format ?? "mp3";
        const outputPath = resolveMediaPath(
          cwd,
          input.output ?? inputPath.replace(extname(inputPath), `.${format}`),
        );
        const ready = await requireCommand("ffmpeg");
        if (ready) return ready;
        if (!existsSync(inputPath)) return "Error: input file not found — " + inputPath;
        const blocked = await guardMediaWrite(ctx, "extract_audio", outputPath, input.overwrite);
        if (blocked) return blocked;
        mkdirSync(dirname(outputPath), { recursive: true });
        const args = [input.overwrite ? "-y" : "-n", "-i", inputPath, "-vn"];
        if (format === "mp3") args.push("-codec:a", "libmp3lame", "-q:a", "2");
        args.push(outputPath);
        await runCommandCapture("ffmpeg", args, cwd, 300_000);
        return mediaOutputSummary("Extracted audio", outputPath);
      },
    }),

    thumbnail: tool({
      description: "Generate a still-image thumbnail from a local video.",
      inputSchema: thumbnailSchema,
      execute: async (input: z.infer<typeof thumbnailSchema>) => {
        const inputPath = resolveMediaPath(cwd, input.input);
        const outputPath = resolveMediaPath(cwd, input.output);
        const ready = await requireCommand("ffmpeg");
        if (ready) return ready;
        if (!existsSync(inputPath)) return "Error: input file not found — " + inputPath;
        const blocked = await guardMediaWrite(ctx, "thumbnail", outputPath, input.overwrite);
        if (blocked) return blocked;
        mkdirSync(dirname(outputPath), { recursive: true });
        await runCommandCapture(
          "ffmpeg",
          [input.overwrite ? "-y" : "-n", "-ss", input.time ?? "00:00:01", "-i", inputPath, "-frames:v", "1", outputPath],
          cwd,
          120_000,
        );
        return mediaOutputSummary("Generated thumbnail", outputPath);
      },
    }),
  };
}
