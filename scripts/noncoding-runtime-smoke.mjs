import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createDesktopTools } from "../dist/tools-desktop.js";
import { createDataTools } from "../dist/tools-data.js";
import { createMediaTools } from "../dist/tools-media.js";
import { createExtensionTools } from "../dist/tools-extension.js";
import { createGeneralTools } from "../dist/tools-general.js";

const root = `/private/tmp/servus-noncoding-smoke-${Date.now()}`;
mkdirSync(root, { recursive: true });

function assertIncludes(value, expected, label) {
  if (!String(value).includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}:\n${value}`);
  }
}

const desktop = createDesktopTools(root);
const data = createDataTools({ cwd: root });
const media = createMediaTools(root);
const extension = createExtensionTools({ cwd: root });
const general = createGeneralTools();

const source = join(root, "source.txt");
const copied = join(root, "copied.txt");
writeFileSync(source, "hello from Servus\n", "utf-8");

assertIncludes(await desktop.desktop_preview.execute({ path: source }), "Path preview", "desktop_preview");
assertIncludes(await desktop.desktop_operation_plan.execute({ action: "copy", source, destination: copied }), "Operation plan", "desktop_operation_plan");
assertIncludes(await desktop.file_copy.execute({ source, destination: copied, overwrite: true }), "Copied", "file_copy");
assertIncludes(await desktop.desktop_verify_action.execute({ action: "copy", target: copied, expectedExists: true }), "passed", "desktop_verify_action");

const table = join(root, "sample.csv");
writeFileSync(table, "name,team,score\nA,red,10\nB,blue,15\nC,red,5\n", "utf-8");
assertIncludes(await data.data_schema_infer.execute({ path: table }), "Schema inference", "data_schema_infer");
assertIncludes(await data.data_summarize_table.execute({ path: table, groupBy: ["team"] }), "Table summary", "data_summarize_table");
assertIncludes(await data.data_query_table.execute({ path: table, where: [{ column: "team", op: "eq", value: "red" }] }), "Output rows: 2", "data_query_table");

assertIncludes(await media.media_presets.execute({}), "Media presets", "media_presets");
assertIncludes(await media.media_plan_job.execute({ operation: "info", input: source }), "Media job plan", "media_plan_job");

const skillResult = await extension.create_skill.execute({
  name: "smoke-skill",
  description: "Smoke skill used by the Servus non-coding smoke test.",
  prompt: "Use for smoke testing.",
  target: "project",
  overwrite: true,
});
assertIncludes(skillResult, "Created Servus skill", "create_skill");
const skillPath = join(root, ".servus", "skills", "smoke-skill", "SKILL.md");
if (!existsSync(skillPath)) throw new Error(`Expected skill file to exist: ${skillPath}`);
assertIncludes(await extension.extension_test_activation.execute({ path: skillPath }), "Activation test: passed", "extension_test_activation");

assertIncludes(await general.general_route_task.execute({ task: "Convert this mp4 to mp3" }), "Routing decision: media", "general_route_task");
assertIncludes(await general.general_answer_with_basis.execute({
  answer: "Use the media domain for that conversion.",
  basis: [{ type: "routing_decision", summary: "The task asks for media conversion." }],
  routeTo: "media",
  confidence: "high",
}), "General answer basis", "general_answer_with_basis");

console.log("noncoding-runtime smoke passed");
