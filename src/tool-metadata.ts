import type { TaskDomain } from "./engine.js";
import type { ToolRisk, ToolSource } from "./runtime.js";

export interface ServusToolMetadata {
  name: string;
  domain: TaskDomain;
  source: ToolSource;
  risk: ToolRisk;
  readOnly: boolean;
  requiresConsent?: boolean;
  timeoutMs?: number;
}

export const DESKTOP_TOOL_METADATA: ServusToolMetadata[] = [
  { name: "desktop_search", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 20_000 },
  { name: "desktop_inspect_path", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "desktop_preview", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "desktop_recent", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 20_000 },
  { name: "desktop_operation_plan", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "desktop_batch_plan", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "desktop_select_candidate", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "desktop_verify_action", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "open", domain: "desktop", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 10_000 },
  { name: "spotlight", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 15_000 },
  { name: "clipboard_read", domain: "desktop", source: "core", risk: "medium", readOnly: true, requiresConsent: true, timeoutMs: 5_000 },
  { name: "clipboard_write", domain: "desktop", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 5_000 },
  { name: "file_move", domain: "desktop", source: "core", risk: "high", readOnly: false, requiresConsent: true, timeoutMs: 10_000 },
  { name: "file_copy", domain: "desktop", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 10_000 },
  { name: "trash", domain: "desktop", source: "core", risk: "high", readOnly: false, requiresConsent: true, timeoutMs: 10_000 },
  { name: "disk_usage", domain: "desktop", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
];

export const MEDIA_TOOL_METADATA: ServusToolMetadata[] = [
  { name: "media_readiness", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "media_presets", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "media_plan_job", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "media_batch_plan", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "media_progress_summary", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "video_info", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 30_000 },
  { name: "media_info", domain: "media", source: "core", risk: "low", readOnly: true, timeoutMs: 15_000 },
  { name: "download_video", domain: "media", source: "core", risk: "medium", readOnly: false, timeoutMs: 300_000 },
  { name: "convert_media", domain: "media", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 300_000 },
  { name: "trim_media", domain: "media", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 300_000 },
  { name: "compress_media", domain: "media", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 300_000 },
  { name: "extract_audio", domain: "media", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 300_000 },
  { name: "thumbnail", domain: "media", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 120_000 },
];

export const DATA_TOOL_METADATA: ServusToolMetadata[] = [
  { name: "data_readiness", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "document_info", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 30_000 },
  { name: "extract_document_text", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 60_000 },
  { name: "extract_table", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 60_000 },
  { name: "data_profile", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 60_000 },
  { name: "data_schema_infer", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 60_000 },
  { name: "data_query_table", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 60_000 },
  { name: "data_summarize_table", domain: "data", source: "core", risk: "low", readOnly: true, timeoutMs: 60_000 },
  { name: "data_merge_tables", domain: "data", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 60_000 },
  { name: "data_report_template", domain: "data", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 30_000 },
  { name: "write_table", domain: "data", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 60_000 },
  { name: "convert_table", domain: "data", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 60_000 },
  { name: "create_report", domain: "data", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 60_000 },
];

export const EXTENSION_TOOL_METADATA: ServusToolMetadata[] = [
  { name: "extension_readiness", domain: "extension", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "create_skill", domain: "extension", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 30_000 },
  { name: "create_plugin", domain: "extension", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 30_000 },
  { name: "validate_extension", domain: "extension", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "extension_import_package", domain: "extension", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 30_000 },
  { name: "extension_export_package", domain: "extension", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 30_000 },
  { name: "extension_test_activation", domain: "extension", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "extension_repair_manifest", domain: "extension", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 10_000 },
];

export const GENERAL_TOOL_METADATA: ServusToolMetadata[] = [
  { name: "general_route_task", domain: "general", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "general_answer_with_basis", domain: "general", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
];

export const SECURITY_TOOL_METADATA: ServusToolMetadata[] = [
  { name: "security_readiness", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_preflight", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "security_pipeline_plan", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_scan_mode_plan", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_context_playbook", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_pre_recon_code_map", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 60_000 },
  { name: "security_vulnerability_class_plan", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_create_validation_queue", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "security_exploitation_decision", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_classify_validation_result", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_report_filter", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_http_request", domain: "security", source: "core", risk: "medium", readOnly: true, requiresConsent: true, timeoutMs: 30_000 },
  { name: "security_request_history", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_repeat_request", domain: "security", source: "core", risk: "medium", readOnly: true, requiresConsent: true, timeoutMs: 30_000 },
  { name: "security_extract_endpoints", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 60_000 },
  { name: "security_cors_audit", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 20_000 },
  { name: "security_cookie_audit", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 20_000 },
  { name: "security_external_tool_readiness", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 10_000 },
  { name: "security_run_cli_tool", domain: "security", source: "core", risk: "high", readOnly: true, requiresConsent: true, timeoutMs: 120_000 },
  { name: "security_cvss_score", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_create_finding", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_scope_check", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_http_probe", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 30_000 },
  { name: "security_header_audit", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 30_000 },
  { name: "security_tls_summary", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 20_000 },
  { name: "security_static_secrets_scan", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 60_000 },
  { name: "security_mode_plan", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_playbook", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 5_000 },
  { name: "security_attack_surface_map", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 60_000 },
  { name: "security_static_code_scan", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 60_000 },
  { name: "security_dependency_audit", domain: "security", source: "core", risk: "low", readOnly: true, timeoutMs: 15_000 },
  { name: "security_config_audit", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 60_000 },
  { name: "security_log_analysis", domain: "security", source: "core", risk: "medium", readOnly: true, timeoutMs: 30_000 },
  { name: "security_create_report", domain: "security", source: "core", risk: "medium", readOnly: false, requiresConsent: true, timeoutMs: 30_000 },
];

export function builtInToolMetadata(): ServusToolMetadata[] {
  return [
    ...DESKTOP_TOOL_METADATA,
    ...MEDIA_TOOL_METADATA,
    ...DATA_TOOL_METADATA,
    ...EXTENSION_TOOL_METADATA,
    ...GENERAL_TOOL_METADATA,
    ...SECURITY_TOOL_METADATA,
  ];
}
