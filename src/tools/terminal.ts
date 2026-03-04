import { tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export const executeTerminalCommandTool = tool({
    description: 'Runs shell commands (e.g., npm install, pytest, git status). Returns stdout and stderr.',
    inputSchema: z.object({
        command: z.string().describe('The terminal command to execute.')
    }),
    execute: async ({ command }: { command: string }): Promise<string> => {
        try {
            if (!command) return 'Error: You must provide a valid command string.';
            // Basic safety check for disastrous commands
            if (command.includes('rm -rf /') || command.includes('sudo rm')) {
                return `Command execution blocked for safety reasons: ${command}`;
            }

            const { stdout, stderr } = await execAsync(command, { cwd: process.cwd() });
            return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
        } catch (error: any) {
            return `COMMAND FAILED.\nExit Code: ${error.code}\nError: ${error.message}\nSTDOUT:\n${error.stdout}\nSTDERR:\n${error.stderr}`;
        }
    },
});
