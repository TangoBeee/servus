const STATUS_TAG_RE = /<[^>]+>/g;
const ANSI_RE = /\u001b\[[0-9;]*m/g;

const STRONG_CLARIFICATION_PATTERNS = [
  /\bi need (?:a few|some|more|the following|these|your)\b/i,
  /\bneed(?:ed)? (?:more|additional|the following|these|your) (?:details|information|info|inputs?)\b/i,
  /\bmissing (?:required )?(?:details|information|info|inputs?|fields)\b/i,
  /\bbefore i can\b/i,
  /\bplease (?:provide|share|tell me|choose|confirm|send)\b/i,
  /\bcould you (?:provide|share|tell me|choose|confirm|send)\b/i,
  /\bcan you (?:provide|share|tell me|choose|confirm|send)\b/i,
  /\bwhat (?:city|date|time|theater|cinema|location|option|preference|email|phone|name)\b/i,
  /\bwhich (?:option|date|time|theater|cinema|location|seat|show)\b/i,
  /\blet me know\b/i,
  /\bneeds? clarification\b/i,
  /\bcan't proceed without\b/i,
  /\bcannot proceed without\b/i,
];

const IRREVERSIBLE_TASK_RE =
  /\b(book|booking|reserve|reservation|buy|purchase|checkout|payment|pay|order|ticket|flight|hotel|appointment)\b/i;

export type ClarificationMode = "blocking_facts" | "discovered_choices" | "consent";

export interface ClarificationChoiceGroup {
  id: string;
  label: string;
  options: string[];
  required?: boolean;
}

export interface ClarificationRequest {
  mode: ClarificationMode;
  message: string;
  context: string;
  questions: string[];
  choices?: ClarificationChoiceGroup[];
  answers?: Record<string, string>;
  sameSession: true;
}

export function stripProtocolTags(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/<task_status>\s*[^<]*\s*<\/task_status>/gi, "")
    .replace(/<plan_status>\s*[^<]*\s*<\/plan_status>/gi, "")
    .replace(/<test_result>\s*[^<]*\s*<\/test_result>/gi, "")
    .replace(/<decision>\s*[^<]*\s*<\/decision>/gi, "")
    .replace(STATUS_TAG_RE, "")
    .trim();
}

export function hasNeedsInputTag(text: string): boolean {
  return /<task_status>\s*NEEDS_INPUT\s*<\/task_status>/i.test(text);
}

export function detectClarificationRequest(text: string, task = ""): ClarificationRequest | null {
  const cleaned = stripProtocolTags(text);
  if (!cleaned) return null;

  const mode = inferClarificationMode(cleaned, task);
  const choices = extractChoices(cleaned, mode);
  const questions = ensureQuestions(extractQuestions(cleaned), mode);
  const hasQuestionList = questions.length > 0;
  const hasQuestionMark = cleaned.includes("?");
  const strongPhrase = STRONG_CLARIFICATION_PATTERNS.some((pattern) => pattern.test(cleaned));
  const irreversibleContext = IRREVERSIBLE_TASK_RE.test(task) || IRREVERSIBLE_TASK_RE.test(cleaned);

  if (hasNeedsInputTag(text)) {
    return {
      mode,
      message: cleaned,
      context: extractContext(cleaned, questions, mode),
      questions,
      ...(choices.length > 0 ? { choices } : {}),
      sameSession: true,
    };
  }

  if (!strongPhrase) return null;
  if (!hasQuestionMark && !hasQuestionList && !irreversibleContext) return null;

  return {
    mode,
    message: cleaned,
    context: extractContext(cleaned, questions, mode),
    questions,
    ...(choices.length > 0 ? { choices } : {}),
    sameSession: true,
  };
}

function extractQuestions(text: string): string[] {
  const extracted: string[] = [];
  const lines = text.split(/\r?\n/);
  let capture = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isStopHeader(trimmed)) {
      capture = false;
      continue;
    }

    if (shouldSkipQuestionLine(trimmed)) {
      continue;
    }

    const enumerated = stripListMarker(trimmed);
    if (capture && enumerated && looksLikeQuestion(enumerated)) {
      extracted.push(enumerated);
      continue;
    }

    if (isQuestionCue(trimmed)) {
      capture = true;
      const inline = inlineQuestion(trimmed) ?? inlineRequestQuestion(trimmed);
      if (inline) extracted.push(inline);
      continue;
    }

    const directRequest = inlineRequestQuestion(trimmed);
    if (directRequest && !isFactualHeader(trimmed) && !looksLikeChoiceLine(trimmed)) {
      extracted.push(directRequest);
      continue;
    }

    if (trimmed.includes("?") && !isFactualHeader(trimmed) && !looksLikeChoiceLine(trimmed)) {
      extracted.push(cleanQuestionText(enumerated || trimmed));
      continue;
    }
  }

  return uniqueQuestions(extracted).slice(0, 12);
}

function extractContext(message: string, questions: string[], mode: ClarificationMode): string {
  let context = message;

  for (const question of questions) {
    const escaped = escapeRegExp(question);
    context = context.replace(new RegExp(`^\\s*(?:[-*\\u2022]|\\d+[.)])\\s*${escaped}\\s*$`, "gim"), "");
    context = context.replace(new RegExp(`^\\s*${escaped}\\s*$`, "gim"), "");
  }

  context = context
    .replace(/^\s*(?:please reply with just|please reply|answer with|provide|send|tell me):?\s*$/gim, "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      const content = stripListMarker(trimmed) ?? trimmed;
      const prompt = inlineQuestion(content) ?? inlineRequestQuestion(content) ?? (looksLikeQuestion(content) ? cleanQuestionText(content) : "");
      const isCurrentQuestion = prompt && questions.some((question) => sameQuestion(question, prompt));
      const isGeneric = isGenericFallbackQuestion(content);
      return (
        !shouldSkipQuestionLine(trimmed) &&
        !isCurrentQuestion &&
        !isGeneric &&
        (mode !== "blocking_facts" || !looksLikeQuestion(content))
      );
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return context || "Servus needs more input before it can continue.";
}

function stripListMarker(line: string): string | null {
  const match = line.match(/^(?:[-*\u2022]|\d+[.)])\s+(.+)$/);
  if (!match) return null;
  return match[1].trim();
}

function isQuestionCue(line: string): boolean {
  return (
    /^(?:please reply|reply with|answer with|provide|send|tell me|choose|confirm|questions?|missing details?)\b/i.test(line) ||
    /\bi need\b.+\b(?:basics?|facts?|fields?|details|information|answers?|choice|confirmation)\b/i.test(line) ||
    /\bmissing\b.+\b(?:details|information|answers?|choice|confirmation)\b/i.test(line) ||
    /\bbefore i can\b/i.test(line) ||
    /\bplease (?:provide|share|tell me|choose|confirm|send)\b/i.test(line)
  );
}

function inlineQuestion(line: string): string | null {
  if (!line.includes("?")) return null;
  const cleaned = cleanQuestionText(line.replace(/^(?:please|could you|can you)\s+/i, "").trim());
  return cleaned.endsWith("?") ? cleaned : null;
}

function inlineRequestQuestion(line: string): string | null {
  const cleaned = cleanQuestionText(stripListMarker(line) ?? line);
  if (!cleaned || cleaned.includes("?")) return null;

  if (/\b(?:mobile|phone)\s+number\b/i.test(cleaned) || /\bphone\b/i.test(cleaned)) {
    return /login|verification|otp|booking/i.test(cleaned)
      ? "What mobile number should Servus use for login/verification?"
      : "What mobile number should Servus use?";
  }

  if (/\bemail(?:\s+address)?\b/i.test(cleaned)) {
    return "What email address should Servus use?";
  }

  const request = cleaned.match(/^(?:please\s+)?(?:send|provide|share|enter|type)\s+(.+?)(?:[.!]?\s*)$/i);
  if (!request?.[1]) return null;

  const target = request[1]
    .replace(/\byou want me to use\b/i, "Servus should use")
    .replace(/\bme to use\b/i, "Servus should use")
    .replace(/\s+/g, " ")
    .trim();
  if (!target) return null;
  return `What is ${target.replace(/[.!?]+$/g, "")}?`;
}

function isStopHeader(line: string): boolean {
  return /^(?:sources?|screenshot(?:\s+taken)?|artifacts?|proof|what i found|availability checked|available options?|examples? i found|options?|important|notes?|url|title):/i.test(line);
}

function isFactualHeader(line: string): boolean {
  return /^(?:what i found|availability checked|available options?|examples? i found|options?|important|sources?|screenshot|artifacts?|proof|notes?|url|title):/i.test(line);
}

function uniqueQuestions(questions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const question of questions) {
    const normalized = question.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferClarificationMode(message: string, task: string): ClarificationMode {
  const combined = `${task}\n${message}`;
  if (/\b(?:basics? first|basic booking details|missing basic|before i can (?:search|look up|browse)|needed before i can (?:search|look up|browse))\b/i.test(message)) {
    return "blocking_facts";
  }

  const asksForFinalApproval =
    /\b(consent|approve|approval|authorize|permission)\b/i.test(message) ||
    /\b(?:confirm|proceed with|ready to)\s+(?:the\s+)?(?:booking|reservation|purchase|payment|checkout|order|sending|posting|deletion)\b/i.test(message) ||
    /\b(?:shall|should)\s+i\s+(?:book|reserve|purchase|buy|pay|checkout|order|send|post|delete)\b/i.test(message);
  const asksForDetailsConfirmation =
    /\bconfirm\s+(?:the\s+)?(?:exact\s+)?(?:movie|title|city|area|location|date|time|option|choice|details?|name)\b/i.test(message);

  if (asksForFinalApproval && !asksForDetailsConfirmation && /\b(book|reserve|purchase|buy|pay|checkout|send|post|delete|order)\b/i.test(combined)) {
    return "consent";
  }

  if (
    /\b(available|availability|options?|choices?|examples? i found|i found|found the following|here are)\b/i.test(message) &&
    /\b(which|choose|select|preference|reply|confirm)\b/i.test(message)
  ) {
    return "discovered_choices";
  }

  return "blocking_facts";
}

function ensureQuestions(questions: string[], mode: ClarificationMode): string[] {
  if (questions.length > 0) {
    const normalized = normalizeQuestionsForMode(uniqueQuestions(questions), mode)
      .filter((question) => !isGenericFallbackQuestion(question));
    if (normalized.length > 0) return normalized.slice(0, 10);
  }
  if (mode === "discovered_choices") {
    return ["Which option should Servus use?"];
  }
  if (mode === "consent") {
    return ["Do you approve this irreversible action? Reply yes only if you want Servus to proceed."];
  }
  return ["What detail should Servus use to continue?"];
}

function shouldSkipQuestionLine(line: string): boolean {
  return (
    isUrlLike(line) ||
    isPathLike(line) ||
    /^(?:url|title|source|sources?|screenshot|artifact|proof)\s*:/i.test(line) ||
    /^\[.*\]\(https?:\/\//i.test(line)
  );
}

function looksLikeQuestion(line: string): boolean {
  if (line.includes("?")) return true;
  if (looksLikeBlockingFact(line)) return true;
  if (inlineRequestQuestion(line)) return true;
  return /^(?:which|what|where|when|who|how many|how much|please|provide|share|tell me|choose|select|confirm|reply|do you|would you|are you|any)\b/i.test(line);
}

function looksLikeChoiceLine(line: string): boolean {
  const stripped = stripListMarker(line) ?? line;
  if (isUrlLike(stripped) || isPathLike(stripped)) return true;
  if (/^(?:https?:\/\/|file:\/\/|\/|~\/)/i.test(stripped)) return true;
  if (/^(?:screenshot|source|url|title|proof|artifact)\s*:/i.test(stripped)) return true;
  if (/^(?:which|what|where|when|who|how many|how much|do you|would you|are you|any)\b/i.test(stripped)) return false;
  return (
    /\b(?:am|pm|₹|\$|usd|inr|available|sold out|seats?|slots?|show(?:time)?|venue|provider|class|format|imax|4dx|2d|3d)\b/i.test(stripped) ||
    /^[A-Z0-9][^?]{8,180}$/.test(stripped)
  );
}

function normalizeQuestionsForMode(questions: string[], mode: ClarificationMode): string[] {
  if (mode !== "blocking_facts") return questions;
  const filtered = questions
    .map(normalizeBlockingQuestion)
    .filter((question) => question.length > 0)
    .filter((question) => !isOptionalBlockingFactLine(question));
  return filtered.length > 0 ? uniqueQuestions(filtered) : questions;
}

function looksLikeBlockingFact(line: string): boolean {
  return /^(?:city|area|location|preferred date|date|item|service|category|required count|exact .+title|exact .+name|movie title|film title|name|email|phone)\b/i.test(line) ||
    /\bconfirm\s+(?:the\s+)?(?:exact\s+)?(?:movie|film|show|event|item|service)?\s*(?:title|name)\b/i.test(line);
}

function isOptionalBlockingFactLine(line: string): boolean {
  return /\b(?:time preference|approximate time|preferred time|time slot|seat|row|format|2d|3d|imax|4dx|theatre|theater|cinema|venue|provider|showtime|fallback)\b/i.test(line) ||
    /\b(?:morning|afternoon|evening|night)\b/i.test(line) ||
    /\b(?:prefer|preference|okay|ok|works?)\b[^?.!\n]*\b(?:morning|afternoon|evening|night)\b/i.test(line);
}

function normalizeBlockingQuestion(question: string): string {
  const cleaned = cleanQuestionText(question).replace(/\s+if any\b/gi, "").trim();
  if (!cleaned) return "";
  const request = inlineRequestQuestion(cleaned);
  if (request) return request;
  if (/\bconfirm\s+(?:the\s+)?(?:exact\s+)?(?:movie|film|show|event|item|service)?\s*(?:title|name)\b/i.test(cleaned)) {
    return "Confirm the exact title/name.";
  }
  if (isOptionalBlockingFactLine(cleaned)) {
    return "";
  }
  return cleaned;
}

function extractChoices(message: string, mode: ClarificationMode): ClarificationChoiceGroup[] {
  if (mode === "blocking_facts") return [];

  const groups: ClarificationChoiceGroup[] = [];
  const options: string[] = [];
  let capture = false;

  for (const rawLine of message.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^(?:available options?|examples? i found|options?|choices?|venues?|providers?|times?|showtimes?|formats?|classes?):/i.test(line)) {
      capture = true;
      continue;
    }

    if (/^(?:sources?|screenshot|artifacts?|proof|notes?|important|url|title):/i.test(line)) {
      capture = false;
      continue;
    }

    const stripped = stripListMarker(line);
    if (!capture || !stripped) continue;
    if (shouldSkipQuestionLine(stripped) || looksLikeQuestion(stripped)) continue;
    if (stripped.length < 3 || stripped.length > 220) continue;
    options.push(stripped);
  }

  const uniqueOptions = uniqueQuestions(options).slice(0, 20);
  if (uniqueOptions.length > 0) {
    groups.push({
      id: "discovered_options",
      label: "Discovered options",
      options: uniqueOptions,
      required: mode === "discovered_choices",
    });
  }
  return groups;
}

function isUrlLike(line: string): boolean {
  return /(?:^|\s)(?:https?:\/\/|file:\/\/|data:|www\.)\S+/i.test(line);
}

function isPathLike(line: string): boolean {
  return /(?:^|\s)(?:~\/|\/tmp\/|\/Users\/|\.servus\/|[\w.-]+\.png\b|[\w.-]+\.jpg\b|[\w.-]+\.json\b)/i.test(line);
}

function cleanQuestionText(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function sameQuestion(a: string, b: string): boolean {
  return normalizeComparable(a) === normalizeComparable(b);
}

function normalizeComparable(value: string): string {
  return cleanQuestionText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isGenericFallbackQuestion(line: string): boolean {
  return /\bprovide the missing basic details needed to continue\b/i.test(line) ||
    /\bwhat detail should servus use to continue\b/i.test(line) ||
    /\breply with your selected option\b/i.test(line);
}
