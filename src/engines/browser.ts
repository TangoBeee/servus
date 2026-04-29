/**
 * Browser Engine — handles web browsing, research, and interactive automation.
 *
 * Two tiers:
 *   Tier 1 (default): webfetch + web_search + web_extract — read-only web agent
 *   Tier 2: Full interactive browser with clicking,
 *          form filling, navigation, and screenshot capture
 *
 */

import { createAgent, type AgentResponse, type IAgent } from "../agent.js";
import { log, ANSI, formatDuration } from "../log.js";
import { bus } from "../events.js";
import { createBrowserTools } from "../tools-browser.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { detectClarificationRequest, stripProtocolTags } from "../clarification.js";
import { updateBrowserSessionState } from "../browser-session.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { resultFromValidatedResponse } from "../agentic-loop.js";
import { getFinalization, validateCompletion } from "../completion-validator.js";

// ─── Browser System Prompts ─────────────────────────────────────────────────

const TIER1_PROMPT = `
# Role: Web Research Agent

You are the **Web Research Agent** in the Servus agent system.
Your job is to browse the web, research topics, extract data, compare information,
and compile findings autonomously when enough information is available.

${SERVUS_OPERATING_LOOP}

## Your Capabilities

1. **Web Search**
   - Use \`web_search\` to find relevant web pages for a query
   - Returns titles, URLs, and snippets from search results

2. **Page Fetching**
   - Use \`webfetch\` to fetch and read the content of any URL
   - HTML is automatically converted to readable text
   - Use \`web_extract\` to pull structured data (prices, dates, lists, tables) from a URL

3. **Multi-Page Research**
   - Use \`web_multi_fetch\` to fetch multiple pages in parallel
   - Compare data across sources for accuracy

4. **Artifacts**
   - Use browser screenshots and extracted source URLs as proof
   - Ask for the data engine if the user needs document/report generation

## Output

When research is complete, call \`servus_done\` with source/page evidence.

Include your findings with source URLs cited.

If the task cannot proceed without required user details, call \`servus_need_input\`.
Ask one clear, minimum specific question needed to continue. Do not repeat
questions already answered in this same session.

## Rules

- ALWAYS cite sources with URLs
- Cross-reference information from multiple sources when possible
- NEVER fabricate URLs or information — only report what you actually fetched
`.trim();

const TIER2_PROMPT = `
# Role: Interactive Web Agent

You are the **Interactive Web Agent** in the Servus agent system.
You have a REAL browser — you can navigate pages, click buttons, fill forms,
take screenshots, and extract data. You operate autonomously.

${SERVUS_OPERATING_LOOP}

## Your Capabilities

### Basic Web (always available)
- \`web_search\` — search the web for info
- \`webfetch\` — fetch a page as text
- \`web_extract\` — extract structured data from a URL
- \`web_multi_fetch\` — fetch multiple URLs in parallel

### Interactive Browser (powered by Playwright)
- \`browser_navigate\` — go to a URL in the real Chrome browser
- \`browser_current_state\` — inspect current URL/title/session/block status
- \`browser_snapshot\` / \`browser_observe\` — capture a compact hybrid page tree with stable refs; observe ranks actions with the model
- \`browser_act\` — model-selected atomic action with deterministic execution, cache replay, two-step dropdown support, and self-heal
- \`browser_agent\` — bounded mini browser controller for small high-level subtasks; stops on blockers instead of looping
- \`browser_click_ref\`, \`browser_fill_ref\`, \`browser_select_ref\`, \`browser_hover_ref\`, \`browser_drag_ref\`, \`browser_upload_ref\` — deterministic ref-based actions
- \`browser_scroll\`, \`browser_wait\`, \`browser_wait_for_selector\`, \`browser_back\`, \`browser_forward\`, \`browser_reload\`, \`browser_key\` — navigation and interaction helpers
- \`browser_pages\`, \`browser_new_page\`, \`browser_select_page\`, \`browser_close_page\` — tab/page helpers
- \`browser_element_info\`, \`browser_highlight\`, \`browser_set_viewport\`, \`browser_cookies\`, \`browser_set_headers\`, \`browser_add_init_script\` — diagnostic/context helpers
- \`browser_click_at\`, \`browser_type_at\`, \`browser_scroll_at\` — viewport coordinate actions for visual-only controls, popups, custom dropdowns, canvas/seat maps, and UI missing from DOM refs
- \`browser_click\`, \`browser_fill\`, \`browser_press\` — legacy aliases for observed elements/keyboard
- \`browser_extract\` — extract text from the current page
- \`browser_screenshot\` — capture a model-visible screenshot; use \`annotateRefs: true, fullPage: false\` when refs need visual grounding
- \`browser_close\` — close the browser when done

## Strategy

1. **Simple research?** → Use \`web_search\` + \`webfetch\` (faster, no browser needed)
2. **Need to interact?** → Use \`browser_navigate\` to open the site.
3. **Finding Elements?** → Call \`browser_observe\` with your goal, or \`browser_snapshot\` when you need the full ref list.
4. **Acting?** → Prefer \`browser_act\` for one atomic instruction. Use \`browser_agent\` only for a bounded small subtask, not an entire booking. Use ref tools when you already know the ref.
5. **Visual mismatch?** → Use \`browser_snapshot\` with \`includeScreenshot: true\` or \`browser_screenshot\`; screenshots are model-visible and annotated when requested.
6. **Need proof?** → Use \`browser_screenshot\` to capture results.
7. **Stuck?** → Take a fresh snapshot. Do not retry the same failed action more than twice.

## Modals, Dropdowns, And Search Menus

- Treat visible modals, popovers, listboxes, autocomplete menus, and search dropdowns
  as the active surface. Do not keep scrolling the background page when a popup is open.
- For dropdown/search controls, use a two-step flow: open or fill the control,
  take/use a fresh snapshot, then select a real visible option. Prefer
  \`browser_act\` with an explicit \`value\`, \`browser_select_ref\`, or
  \`browser_agent\` for small dropdown/modal subtasks.
- If a popup option is not visible, use \`browser_scroll\`; it targets the active
  popup/listbox first. Do not tab through the page blindly.
- When an action result says \`Visual change detected: true\`, assume the page
  changed even if the URL/title did not. Immediately call \`browser_snapshot\`
  again, using \`includeScreenshot: true\` if the new UI is not clearly listed.
- If the screenshot shows a visible control but refs do not include it, use
  \`browser_click_at\`, \`browser_type_at\`, or \`browser_scroll_at\` with viewport
  coordinates from the screenshot. This is preferred for visual-only menus,
  portaled popups, custom selects, date pickers, and seat maps.
- If a click does not change state after two tries, stop and report the blocker
  instead of looping.

## Booking/Transaction Handling

For tasks involving purchases, bookings, reservations, applications, appointments,
shopping, tickets, forms, or payments:
1. Ask only the single most important fact that blocks useful browsing. Use one
   clear, natural \`NEEDS_INPUT\` question at a time. Good first questions are
   location, date/range, exact item/service/title, or a hard constraint.
   Do not ask optional preferences just because they may help later.
2. Do not ask provider-specific choices up front. Browse first when the basic
   facts are enough to discover real options.
3. After browsing, ask one clear choice question at a time using only real
   discovered options. Do not ask for provider/venue, time/slot, format/type/class,
   quantity/count, seat/preference, or fallback until the page has shown those choices.
4. When ready to execute a transaction, the consent gate will prompt the user.
5. After completing, take a screenshot as proof.

## Output

When the task is complete, call \`servus_done\` with page/proof evidence.

Include results, screenshots taken, and source URLs.
Only output DONE when the user's requested end state was actually reached.
For booking, reservation, shopping, appointment, form, or checkout tasks, DONE
means the workflow reached the expected next durable state, such as available
options returned, seat/slot selection reached, checkout stopped at consent, or
the explicitly approved action completed. If a click did not advance, a site
blocked automation, a login/captcha is required, or an alternate route is
needed, do NOT output DONE.

If the task cannot proceed without required user details, call \`servus_need_input\`.
Ask one minimum specific question needed to continue. Keep the browser/session
open while waiting for the user's answer, and do not repeat questions already
answered in this same session.
For bookings and other real-world workflows, always research options first when
enough basic context exists; only ask before browsing when the missing details
block useful research. Time preferences, seat preferences, provider/theatre,
format/class, fallback preferences, and ticket/guest counts usually belong
after you have found real availability unless the site cannot search without
them.

## Rules

- Close the browser only when the task is done, cancelled, or explicitly requested.
  Do not close it before a \`NEEDS_INPUT\` continuation.
- Never mark a browser task done by saying what failed. If the requested action
  did not complete, report the blocker with \`NEEDS_INPUT\` so the user can
  choose retry, alternate route, takeover, or stop.
- Take screenshots at key steps for proof/audit trail
- For transactions: consent gate will auto-trigger — you don't need to ask
- NEVER fabricate information — only report what you actually saw in the browser
- If you detect captcha, Cloudflare, access denied, login, or bot blocking,
  report it clearly and switch to search/fetch, alternate official sources, or
  ask the user to take over. Do not claim you bypassed it.
`.trim();

// ─── Browser Engine ─────────────────────────────────────────────────────────

export class BrowserEngine implements Engine {
  readonly name = "browser";
  readonly description =
    "Handles web research, data extraction, interactive browsing, form filling, " +
    "bookings, and any task requiring a web browser.";

  private agent: IAgent | null = null;
  private playwrightCleanup: (() => Promise<void>) | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();
    let keepBrowserOpen = false;

    try {
      // Tier 2 is always available now since we use native Playwright
      const tier2 = true;
      const tier = 2;

      log.info(`Browser Engine: Tier ${tier} (Playwright interactive browser)`);

      // Build tools
      const browserTools = createBrowserTools(ctx.cwd);
      let allExtraTools: Record<string, unknown> = browserTools as Record<string, unknown>;

      const { createPlaywrightTools } = await import("../tools-playwright.js");
      const playwrightTools = createPlaywrightTools(ctx);
      this.playwrightCleanup = playwrightTools._cleanup;
      // Merge tools (excluding internal helpers)
      const { _getProofScreenshots, _cleanup, ...publicTools } = playwrightTools;
      allExtraTools = { ...allExtraTools, ...publicTools } as Record<string, unknown>;

      // Create agent with appropriate prompt and tools
      this.agent = await createAgent(ctx.backend, {
        name: "Browser",
        role: "researcher",
        color: ANSI.blue,
        model: ctx.model,
        domain: "browser",
        prompt: tier2 ? TIER2_PROMPT : TIER1_PROMPT,
        extraTools: allExtraTools,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      log.success("Browser agent initialized");

      this.emitStatus("working");

      let response = await this.agent.send(buildBrowserTaskPrompt(ctx.task, tier2));

      if (shouldRetryStreamFailure(response.subtype)) {
        log.warn("Browser agent stream was interrupted; retrying once in the same session.");
        bus.push({
          type: "agent:status",
          agent: "Browser",
          message: "stream interrupted, retrying in same browser session",
        });
        response = await this.agent.send(
          [
            "The previous model/tool stream was interrupted by a transient provider/tool protocol error.",
            "Resume the same task in the same Servus session.",
            "First call browser_current_state or browser_snapshot, then continue from the current page.",
            "Do not restart the booking or close the browser unless the task is done or the user cancels.",
          ].join("\n"),
        );
      }

      const cost = this.agent.cost;
      const elapsed = Date.now() - startTime;
      const clarification = detectClarificationRequest(response.text, ctx.task);
      const cleaned = stripProtocolTags(response.text);

      if (isTransientStreamFailure(response.subtype)) {
        keepBrowserOpen = true;
        this.emitStatus("waiting_input");
        updateBrowserSessionState(ctx.sessionId, {
          status: "waiting_input",
          blockedReason: "Model/tool stream was interrupted; browser state was preserved for resume.",
        });
        const question =
          "The model stream was interrupted, but I kept the browser session saved. Reply \"resume\" to continue from the current page, or \"cancel\" to stop.";
        return {
          success: false,
          needsInput: true,
          summary: question,
          question,
          questions: [question],
          questionContext: cleaned,
          cost,
          error: response.text,
        };
      }

      response = await this.repairInvalidBrowserCompletion(ctx, response);

      const finalized = resultFromValidatedResponse(ctx, "browser", response);
      if (finalized) {
        if (finalized.needsInput) {
          keepBrowserOpen = true;
          this.emitStatus("waiting_input");
          updateBrowserSessionState(ctx.sessionId, { status: "waiting_input" });
        } else if (!finalized.success) {
          keepBrowserOpen = true;
          this.emitStatus("waiting_input");
          updateBrowserSessionState(ctx.sessionId, {
            status: "waiting_input",
            blockedReason: finalized.error ?? "Browser completion was not accepted.",
          });
        } else {
          this.emitStatus(finalized.success ? "done" : "error");
        }
        return finalized;
      }

      if (clarification) {
        log.warn("Browser task is waiting for user input.");
        keepBrowserOpen = true;
        this.emitStatus("waiting_input");
        updateBrowserSessionState(ctx.sessionId, { status: "waiting_input" });
        return {
          success: false,
          needsInput: true,
          summary: clarification.message,
          question: clarification.message,
          questions: clarification.questions,
          questionContext: clarification.context,
          clarification,
          cost,
          error: "Needs user input",
        };
      }

      if (response.text.includes("<task_status>DONE</task_status>")) {
        const blockedCompletion = detectBlockedCompletion(cleaned, ctx.task);
        if (blockedCompletion) {
          log.warn("Browser task reported DONE with an unresolved blocker; keeping session open.");
          keepBrowserOpen = true;
          this.emitStatus("waiting_input");
          updateBrowserSessionState(ctx.sessionId, {
            status: "waiting_input",
            blockedReason: blockedCompletion.reason,
          });
          return {
            success: false,
            needsInput: true,
            summary: blockedCompletion.question,
            question: blockedCompletion.question,
            questions: [blockedCompletion.question],
            questionContext: cleaned,
            cost,
            error: blockedCompletion.reason,
          };
        }

        log.success("Browser task completed in " + formatDuration(elapsed));
        this.emitStatus("done");
        return {
          success: true,
          summary: cleaned,
          cost,
        };
      }

      log.warn("Browser agent did not signal completion.");
      this.emitStatus("error");
      return {
        success: false,
        summary: "Browser agent did not complete the task within the allowed turns.",
        cost,
        error: "Agent did not signal DONE",
      };
    } catch (err) {
      this.emitStatus("error");
      return {
        success: false,
        summary: "Browser engine failed: " + (err instanceof Error ? err.message : String(err)),
        cost: this.agent?.cost ?? 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Cleanup browser if it was used
      if (this.playwrightCleanup && !keepBrowserOpen) {
        try { await this.playwrightCleanup(); } catch { /* ignore */ }
      }
    }
  }

  close(): void {
    this.agent?.close();
  }

  private async repairInvalidBrowserCompletion(
    ctx: EngineContext,
    response: AgentResponse,
  ): Promise<AgentResponse> {
    if (!this.agent) return response;
    const finalization = getFinalization(response);
    if (finalization?.kind !== "done") return response;

    const decision = validateCompletion(ctx, "browser", response);
    if (decision.accepted) return response;

    log.warn("Browser completion failed runtime validation; asking the same session to repair evidence before closing.");
    bus.push({
      type: "runtime:state",
      agent: "Browser",
      message: "completion validation failed; repairing in same browser session",
      metadata: { missingCriteria: decision.missingCriteria },
    });
    updateBrowserSessionState(ctx.sessionId, {
      status: "open",
      blockedReason: `Completion validation missing: ${decision.missingCriteria.join(", ")}`,
    });

    return this.agent.send([
      "## Browser runtime validation failed",
      "You attempted to finish, but Servus cannot accept completion yet.",
      "Do not restart the task. Continue in this same browser session.",
      "",
      "Missing evidence/criteria:",
      ...decision.missingCriteria.map((item) => `- ${item}`),
      "",
      "Next steps:",
      "- Call browser_current_state.",
      "- If the visible UI may differ from DOM text, call browser_snapshot with includeScreenshot=true.",
      "- Gather proof with browser_screenshot or browser_extract.",
      "- If the page is blocked, login/captcha is required, or an action failed, call servus_need_input instead of servus_done.",
      "- Only call servus_done after the requested browser end state is actually visible and proved.",
    ].join("\n"));
  }

  private emitStatus(status: "working" | "waiting_input" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "Browser",
      message: status,
    });
  }
}

function buildBrowserTaskPrompt(task: string, tier2: boolean): string {
  return [
    "## Task",
    task,
    "",
    tier2
      ? "You have a full interactive browser available. Use browser tools for interactive tasks, or webfetch for simple research."
      : "Research this thoroughly using web search and page fetching.",
    "Call servus_done with page/source/proof evidence when finished.",
    "If required user details are missing and you cannot proceed, call servus_need_input and ask only the necessary question.",
  ].join("\n");
}

function shouldRetryStreamFailure(subtype: string): boolean {
  return subtype === "error_stream_protocol";
}

function isTransientStreamFailure(subtype: string): boolean {
  return subtype === "error_stream_protocol" || subtype === "error_rate_limit";
}

function detectBlockedCompletion(text: string, task: string): { reason: string; question: string } | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  const taskText = task.toLowerCase();
  const isRealWorldWorkflow =
    /\b(book|booking|ticket|reservation|reserve|appointment|checkout|purchase|buy|order|payment|seat|slot|showtime|flight|hotel|movie|form|submit)\b/i.test(taskText);
  if (!isRealWorldWorkflow) return null;

  const blocker =
    /\b(?:could not|couldn't|cannot|can't|unable to|failed to|did not|does not|no state changed|no progress|stuck|blocked|captcha|cloudflare|access denied|login required|required login|verification required|did not advance|remained on|not complete|not completed|alternate route|try another|take over)\b/i.test(normalized);
  if (!blocker) return null;

  const reason = firstUsefulSentence(normalized) ?? "The browser workflow hit a blocker before the requested task was completed.";
  return {
    reason,
    question: `${reason} Should I try an alternate official route, keep this page open for you to take over, or stop?`,
  };
}

function firstUsefulSentence(text: string): string | undefined {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return sentences.find((sentence) =>
    /\b(?:could not|couldn't|cannot|can't|unable to|failed to|did not|does not|no progress|blocked|captcha|cloudflare|access denied|login|required|did not advance|remained on|not complete|not completed)\b/i.test(sentence),
  )?.slice(0, 260);
}
