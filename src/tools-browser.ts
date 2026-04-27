/**
 * Browser tools — web search and data extraction for the Browser Engine.
 *
 * These tools extend the base webfetch with structured search and extraction
 * capabilities, enabling the Browser Engine to research topics autonomously.
 */

import { tool } from "ai";
import { z } from "zod";

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_CONTENT = 80_000;

function clampText(str: string, max = MAX_CONTENT): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n\n…(truncated)";
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const webSearchSchema = z.object({
  query: z.string().describe("Search query to find relevant web pages"),
  numResults: z.number().optional().describe("Number of results to return (default: 5, max: 10)"),
});

const webExtractSchema = z.object({
  url: z.string().describe("URL to extract structured data from"),
  extractType: z.enum(["summary", "links", "headings", "tables", "all"]).describe(
    "What to extract: 'summary' for key info, 'links' for all URLs, 'headings' for page structure, 'tables' for tabular data, 'all' for everything",
  ),
});

const webMultiFetchSchema = z.object({
  urls: z.array(z.string()).max(5).describe("List of URLs to fetch in parallel (max 5)"),
});

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function createBrowserTools(_cwd: string) {
  return {
    web_search: tool({
      description: [
        "Search the web for information. Returns titles, URLs, and snippets.",
        "Uses DuckDuckGo HTML search — no API key needed.",
        "Good for: finding relevant pages, getting an overview of a topic, discovering URLs to fetch.",
      ].join("\n"),
      inputSchema: webSearchSchema,
      execute: async (input: z.infer<typeof webSearchSchema>) => {
        const numResults = Math.min(input.numResults ?? 5, 10);
        const query = encodeURIComponent(input.query);
        const url = `https://html.duckduckgo.com/html/?q=${query}`;

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html",
            },
          });
          clearTimeout(timer);

          if (!resp.ok) return `Search error: HTTP ${resp.status}`;

          const html = await resp.text();

          // Parse DuckDuckGo HTML results
          const results: { title: string; url: string; snippet: string }[] = [];
          const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
          let match;

          while ((match = resultRegex.exec(html)) !== null && results.length < numResults) {
            const rawUrl = match[1];
            const title = stripHtml(match[2]);
            const snippet = stripHtml(match[3]);

            // Decode DuckDuckGo redirect URL
            let finalUrl = rawUrl;
            try {
              const decoded = decodeURIComponent(rawUrl);
              const udMatch = decoded.match(/uddg=([^&]+)/);
              if (udMatch) finalUrl = decodeURIComponent(udMatch[1]);
            } catch {
              finalUrl = rawUrl;
            }

            if (title && finalUrl) {
              results.push({ title, url: finalUrl, snippet });
            }
          }

          if (results.length === 0) {
            // Fallback: try to extract any links from the page
            const linkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
            while ((match = linkRegex.exec(html)) !== null && results.length < numResults) {
              const linkUrl = match[1];
              const linkText = stripHtml(match[2]);
              if (linkText.length > 3 && !linkUrl.includes("duckduckgo.com")) {
                results.push({ title: linkText, url: linkUrl, snippet: "" });
              }
            }
          }

          if (results.length === 0) {
            return `No results found for "${input.query}"`;
          }

          const formatted = results.map((r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
          ).join("\n\n");

          return `Search results for "${input.query}":\n\n${formatted}`;
        } catch (err: unknown) {
          return `Search error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    web_extract: tool({
      description: [
        "Extract structured data from a web page.",
        "Supports: 'summary' (key info), 'links' (all URLs), 'headings' (page structure),",
        "'tables' (tabular data), or 'all' (everything).",
      ].join("\n"),
      inputSchema: webExtractSchema,
      execute: async (input: z.infer<typeof webExtractSchema>) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);
          const resp = await fetch(input.url, {
            signal: controller.signal,
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; Servus/2.0)",
              "Accept": "text/html,text/plain,*/*",
            },
          });
          clearTimeout(timer);

          if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
          const html = await resp.text();

          const sections: string[] = [];

          // Summary / Plain text extraction
          if (input.extractType === "summary" || input.extractType === "all") {
            const text = stripHtml(html);
            sections.push("## Summary\n" + clampText(text, 10_000));
          }

          // Headings extraction
          if (input.extractType === "headings" || input.extractType === "all") {
            const headings: string[] = [];
            const headingRegex = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
            let match;
            while ((match = headingRegex.exec(html)) !== null) {
              const level = parseInt(match[1][1]);
              const text = stripHtml(match[2]).trim();
              if (text) headings.push("  ".repeat(level - 1) + `- ${text}`);
            }
            if (headings.length > 0) {
              sections.push("## Headings\n" + headings.join("\n"));
            }
          }

          // Links extraction
          if (input.extractType === "links" || input.extractType === "all") {
            const links: string[] = [];
            const linkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let match;
            while ((match = linkRegex.exec(html)) !== null && links.length < 50) {
              const text = stripHtml(match[2]).trim();
              if (text.length > 2) {
                links.push(`- [${text}](${match[1]})`);
              }
            }
            if (links.length > 0) {
              sections.push("## Links (" + links.length + ")\n" + links.join("\n"));
            }
          }

          // Tables extraction
          if (input.extractType === "tables" || input.extractType === "all") {
            const tableRegex = /<table[\s\S]*?<\/table>/gi;
            let match;
            let tableIdx = 0;
            while ((match = tableRegex.exec(html)) !== null && tableIdx < 5) {
              tableIdx++;
              const rows: string[][] = [];
              const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
              let rowMatch;
              while ((rowMatch = rowRegex.exec(match[0])) !== null) {
                const cells: string[] = [];
                const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
                let cellMatch;
                while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
                  cells.push(stripHtml(cellMatch[1]).trim());
                }
                if (cells.length > 0) rows.push(cells);
              }
              if (rows.length > 0) {
                const formatted = rows.map((r) => "| " + r.join(" | ") + " |").join("\n");
                sections.push("## Table " + tableIdx + "\n" + formatted);
              }
            }
          }

          if (sections.length === 0) {
            return "No extractable content found at " + input.url;
          }

          return clampText("Extracted from: " + input.url + "\n\n" + sections.join("\n\n"));
        } catch (err: unknown) {
          return `Error extracting from ${input.url}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    web_multi_fetch: tool({
      description: "Fetch multiple URLs in parallel. Returns the text content of each. Max 5 URLs at a time.",
      inputSchema: webMultiFetchSchema,
      execute: async (input: z.infer<typeof webMultiFetchSchema>) => {
        const results = await Promise.allSettled(
          input.urls.map(async (url) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 20_000);
            const resp = await fetch(url, {
              signal: controller.signal,
              headers: {
                "User-Agent": "Mozilla/5.0 (compatible; Servus/2.0)",
                "Accept": "text/html,text/plain,*/*",
              },
            });
            clearTimeout(timer);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const html = await resp.text();
            const ct = resp.headers.get("content-type") ?? "";
            return ct.includes("html") ? stripHtml(html) : html;
          }),
        );

        return results.map((r, i) => {
          const url = input.urls[i];
          if (r.status === "fulfilled") {
            return `## ${url}\n${clampText(r.value, 15_000)}`;
          } else {
            return `## ${url}\nError: ${r.reason?.message ?? "Unknown error"}`;
          }
        }).join("\n\n---\n\n");
      },
    }),
  };
}
