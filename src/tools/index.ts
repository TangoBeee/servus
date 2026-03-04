import { readFileTool, writeFileTool, patchFileTool, listDirectoryTool } from './fs';
import { executeTerminalCommandTool } from './terminal';
import { askHumanTool } from './human';
import { spawnSubAgentTool } from './subagent';

export const agentTools = {
    read_file: readFileTool,
    write_file: writeFileTool,
    patch_file: patchFileTool,
    list_directory: listDirectoryTool,
    execute_terminal_command: executeTerminalCommandTool,
    ask_human: askHumanTool,
    spawn_sub_agent: spawnSubAgentTool,
};
