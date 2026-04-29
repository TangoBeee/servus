import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.SERVUS_BROWSER_HEADLESS = process.env.SERVUS_BROWSER_HEADLESS ?? "1";

const dir = mkdtempSync(join(tmpdir(), "servus-browser-smoke-"));
process.env.SERVUS_DIR = join(dir, ".servus");

const { createPlaywrightTools } = await import("../dist/tools-playwright.js");

const htmlPath = join(dir, "fixture.html");
writeFileSync(htmlPath, `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Servus Browser Fixture</title>
  <style>
    body { font: 16px system-ui; margin: 40px; min-height: 1400px; }
    .modal-backdrop { position: fixed; inset: 0; display: none; place-items: center; background: rgba(0,0,0,.62); z-index: 50; }
    .modal-backdrop.open { display: grid; }
    .modal { background: white; color: #111; width: 420px; border-radius: 18px; padding: 24px; box-shadow: 0 24px 80px rgba(0,0,0,.28); }
    .formats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 16px; }
    .format { border: 1px solid #ccc; border-radius: 999px; padding: 12px 14px; background: white; color: #d33; cursor: pointer; }
    .combo { margin-top: 40px; width: 320px; position: relative; }
    .listbox { display: none; position: absolute; z-index: 80; inset-inline: 0; top: 42px; background: white; border: 1px solid #ccc; max-height: 140px; overflow: auto; box-shadow: 0 16px 40px rgba(0,0,0,.18); }
    .listbox.open { display: block; }
    .option { padding: 12px; cursor: pointer; }
    .option:hover { background: #edf4ff; }
  </style>
</head>
<body>
  <h1>Browser smoke fixture</h1>
  <button id="book">Book tickets</button>
  <p id="format-result">Format: none</p>
  <div class="combo">
    <label for="fruit">Search dropdown</label>
    <input id="fruit" placeholder="Search fruit" autocomplete="off">
    <div id="fruit-list" class="listbox" role="listbox">
      <div class="option" role="option">Apple</div>
      <div class="option" role="option">Banana</div>
      <div class="option" role="option">Peach</div>
      <div class="option" role="option">Pear</div>
    </div>
  </div>
  <p id="fruit-result">Fruit: none</p>
  <div id="modal" class="modal-backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <h2>Select language and format</h2>
      <p>English</p>
      <div class="formats">
        <button class="format">ICE</button>
        <button class="format">2D</button>
        <button class="format">IMAX 2D</button>
      </div>
    </div>
  </div>
  <script>
    const modal = document.getElementById("modal");
    document.getElementById("book").onclick = () => modal.classList.add("open");
    document.querySelectorAll(".format").forEach((button) => {
      button.onclick = () => {
        document.getElementById("format-result").textContent = "Format: " + button.textContent;
        modal.classList.remove("open");
      };
    });
    const input = document.getElementById("fruit");
    const list = document.getElementById("fruit-list");
    input.addEventListener("focus", () => list.classList.add("open"));
    input.addEventListener("input", () => list.classList.add("open"));
    document.querySelectorAll(".option").forEach((option) => {
      option.onclick = () => {
        input.value = option.textContent;
        document.getElementById("fruit-result").textContent = "Fruit: " + option.textContent;
        list.classList.remove("open");
      };
    });
  </script>
</body>
</html>`);

const ctx = {
  task: "browser smoke",
  cwd: process.cwd(),
  model: "gpt-5.4",
  backend: "custom",
  maxConsecutiveFailures: 1,
  sessionId: `browser-smoke-${Date.now()}`,
};
const tools = createPlaywrightTools(ctx);

function refFor(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`(ref_[a-f0-9]+)[^\\n]*"${escaped}"`, "i"));
  if (!match) throw new Error(`Could not find ref for ${label} in:\n${output}`);
  return match[1];
}

try {
  await tools.browser_navigate.execute({ url: pathToFileURL(htmlPath).href });
  let snapshot = await tools.browser_snapshot.execute({ instruction: "find the Book tickets button", maxElements: 80 });
  await tools.browser_click_ref.execute({ ref: refFor(snapshot, "Book tickets"), reason: "open format modal" });
  snapshot = await tools.browser_snapshot.execute({ instruction: "find 2D format in the active modal", maxElements: 120 });
  if (!/Active surface:/i.test(snapshot) || !/"2D"/.test(snapshot)) {
    throw new Error(`Modal option was not captured in snapshot:\n${snapshot}`);
  }
  await tools.browser_click_ref.execute({ ref: refFor(snapshot, "2D"), reason: "select visible modal option" });
  let extracted = await tools.browser_extract.execute({ maxChars: 4000 });
  if (!/Format:\s*2D/.test(extracted)) throw new Error(`Modal selection failed:\n${extracted}`);

  snapshot = await tools.browser_snapshot.execute({ instruction: "find search dropdown input", maxElements: 100 });
  await tools.browser_fill_ref.execute({ ref: refFor(snapshot, "Search dropdown"), text: "Peach" });
  snapshot = await tools.browser_snapshot.execute({ instruction: "select Peach from the visible listbox", maxElements: 120 });
  if (!/"Peach"/.test(snapshot)) throw new Error(`Dropdown option was not captured:\n${snapshot}`);
  await tools.browser_click_ref.execute({ ref: refFor(snapshot, "Peach"), reason: "select visible dropdown option" });
  extracted = await tools.browser_extract.execute({ maxChars: 4000 });
  if (!/Fruit:\s*Peach/.test(extracted)) throw new Error(`Dropdown selection failed:\n${extracted}`);

  console.log("browser-runtime-smoke: PASS");
} finally {
  await tools._cleanup();
}
