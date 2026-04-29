/**
 * Media Engine — handles video downloading, audio/video conversion,
 * and media file management.
 *
 * Wraps yt-dlp and ffmpeg CLI tools through a single autonomous agent.
 */

import { createAgent, type IAgent } from "../agent.js";
import { log, ANSI, formatDuration } from "../log.js";
import { bus } from "../events.js";
import { createMediaToolsWithContext } from "../tools-media.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { runDomainWorkflowRuntime } from "../domain-workflow-runtime.js";

// ─── Media System Prompt ────────────────────────────────────────────────────

const MEDIA_PROMPT = `
# Role: Media Assistant

You are the **Media Assistant** in the Servus agent system.
Your job is to download videos, convert media files, and manage audio/video content
autonomously when enough information is available.

${SERVUS_OPERATING_LOOP}

## Your Capabilities

1. **Video Download**
      - Use \`download_video\` to download videos from YouTube, Vimeo, and 1000+ other sites
   - Supports format selection (mp4, mp3, audio-only) and quality selection (720p, 1080p, 4K)
   - Default download location: ~/Downloads

2. **Video/Audio Information**
   - Use \`video_info\` to get metadata about an online video without downloading it
   - Use \`media_info\` to inspect local media files (codec, resolution, duration, bitrate)
   - Use \`media_presets\`, \`media_plan_job\`, and \`media_batch_plan\` to plan outputs safely

3. **Format Conversion**
   - Use \`convert_media\` to convert between formats (e.g. mp4→mp3, wav→flac, mkv→mp4)
   - Use \`trim_media\`, \`compress_media\`, \`extract_audio\`, and \`thumbnail\`
   - Use \`media_progress_summary\` to summarize long ffmpeg/yt-dlp logs for the user
   - Can trim, resize, re-encode, compress, extract audio, and create thumbnails

4. **File Operations**
   - Use \`bash\` for advanced operations (batch processing, piping, etc.)
   - Use \`read\` / \`ls\` / \`glob\` to find and inspect existing media files

## Workflow

1. **Parse the request** — what media operation does the user want?
2. **Check prerequisites** — verify yt-dlp/ffmpeg are installed
3. **Execute** — perform the download/conversion/inspection
4. **Verify** — confirm the output file exists and is valid
5. **Report** — summarize what was done (file path, size, duration)

## Output Protocol

When the task is complete, call \`servus_done\` with file/artifact evidence.

Include file path, size, and any relevant details.

If the task cannot proceed without required user details, do NOT output DONE.
Call \`servus_need_input\`, then ask the minimum specific question needed to continue.

## Rules

- ALWAYS save downloads to ~/Downloads unless the user specifies otherwise
- NEVER download copyrighted content without the user's explicit request
- Use \`video_info\` first if the user wants to preview what they're downloading
- For large files, keep the user informed about progress
- If yt-dlp or ffmpeg is not installed, tell the user how to install them
`.trim();

// ─── Media Engine ───────────────────────────────────────────────────────────

export class MediaEngine implements Engine {
  readonly name = "media";
  readonly description =
    "Handles video downloading, audio/video conversion, and media file management. " +
    "Use for tasks like downloading YouTube videos, converting audio formats, " +
    "trimming clips, or inspecting media files.";

  private agent: IAgent | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      const mediaTools = createMediaToolsWithContext(ctx);

      this.agent = await createAgent(ctx.backend, {
        name: "Media",
        role: "media-handler",
        color: ANSI.magenta,
        model: ctx.model,
        domain: "media",
        prompt: MEDIA_PROMPT,
        extraTools: mediaTools as Record<string, unknown>,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      log.success("Media agent initialized");

      this.emitStatus("working");

      const result = await runDomainWorkflowRuntime({
        agent: this.agent,
        ctx,
        domain: "media",
        progressRequired: true,
        plan: [
          "Check media prerequisites and inspect inputs.",
          "Plan outputs, presets, and overwrite safety before long jobs.",
          "Run the requested operation and summarize progress.",
          "Verify artifact existence, size, and metadata.",
        ],
        evidenceTypes: ["media_probe", "media_job", "conversion_result", "download_result"],
        initialMessage: [
          "## Media Task",
          ctx.task,
          "",
          "## Working Directory",
          "`" + ctx.cwd + "`",
          "",
          "## Default Download Directory",
          "`" + (process.env.HOME ?? "/tmp") + "/Downloads`",
          "",
          "Complete this task using servus_done with file/artifact evidence.",
          "If required user details are missing and you cannot proceed, call servus_need_input and ask only the necessary question.",
        ].join("\n"),
      });
      const elapsed = Date.now() - startTime;
      if (result.needsInput) {
        log.warn("Media task is waiting for user input.");
        this.emitStatus("waiting_input");
        return result;
      }
      if (result.success) {
        log.success("Media task completed in " + formatDuration(elapsed));
        this.emitStatus("done");
        return result;
      }

      this.emitStatus("error");
      return result;
    } catch (err) {
      this.emitStatus("error");
      return {
        success: false,
        summary: "Media engine failed: " + (err instanceof Error ? err.message : String(err)),
        cost: this.agent?.cost ?? 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  close(): void {
    this.agent?.close();
  }

  private emitStatus(status: "working" | "waiting_input" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "Media",
      message: status,
    });
  }
}
