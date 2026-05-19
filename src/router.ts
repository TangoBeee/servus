/**
 * Task Router — classifies user intent and selects the appropriate engine.
 * 
 * Uses a lightweight LLM call to determine which engine should handle a task.
 * Falls back to the Coding engine if classification is ambiguous.
 */

import { generateText } from "ai";
import { resolveModel } from "./provider.js";
import type { TaskDomain } from "./engine.js";
import { log } from "./log.js";

// ─── Classification Prompt ──────────────────────────────────────────────────

const ROUTER_PROMPT = `You are a task classifier for an autonomous agent system called Servus.

Given a user's task, classify it into EXACTLY ONE of these domains:

- **coding**: Writing, editing, debugging, or building software. Includes creating apps, fixing bugs, refactoring, adding features, running tests, deploying code.
- **desktop**: Local file management, searching files/folders, opening applications, clipboard operations, organizing files, system settings. NOT coding — just file/OS operations.
- **browser**: Web browsing, research, data extraction, form filling, bookings, purchases, web scraping, or any task requiring a web browser.
- **media**: Downloading videos, converting audio/video formats, image processing, or media file management.
- **data**: Reading, extracting, converting, or generating PDFs, documents, spreadsheets, CSV/TSV files, tables, or reports.
- **extension**: Creating or updating Servus skills, plugins, extension manifests, activation triggers, or reusable agent capability packs.
- **security**: Authorized security audits, vulnerability analysis, safe recon, OWASP checks, header/TLS review, secret scans, and security reports.
- **general**: Anything that doesn't fit above — general knowledge questions, math, creative writing, etc.

IMPORTANT RULES:
- If the task involves writing or modifying CODE (programming), it is ALWAYS "coding", even if it also involves files.
- "Find the budget PDF on my desktop" → desktop (file search, not coding)
- "Build a React app" → coding
- "Search for flights to London" → browser
- "Download a YouTube video" → media
- "Extract tables from this spreadsheet" → data
- "Summarize this PDF" → data
- "Create a Servus skill for code reviews" → extension
- "Build a plugin that adds travel workflow skills" → extension
- "Audit this web app for OWASP issues" → security
- "Check security headers for this URL" → security
- "Scan this repo for leaked secrets" → security
- "What is the capital of France?" → general

Respond with ONLY the domain name, nothing else. One word.`;

// ─── Router ─────────────────────────────────────────────────────────────────

export async function classifyTask(
  task: string,
  model: string,
): Promise<TaskDomain> {
  try {
    const resolved = resolveModel(model);
    const result = await generateText({
      model: resolved.model,
      system: ROUTER_PROMPT,
      prompt: task,
      temperature: 0,
    });

    const domain = result.text.trim().toLowerCase() as TaskDomain;
    const valid: TaskDomain[] = ["coding", "desktop", "browser", "media", "data", "extension", "security", "general"];

    if (valid.includes(domain)) {
      log.info(`Task classified as: ${domain}`);
      return domain;
    }

    log.warn(`Router returned unknown domain "${domain}", defaulting to coding`);
    return "coding";
  } catch (err) {
    log.warn(`Task classification failed: ${err instanceof Error ? err.message : String(err)}. Defaulting to coding.`);
    return "coding";
  }
}
