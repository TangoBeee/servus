import { tool } from 'ai';
import { z } from 'zod';
import { AgentEngine } from '../agent/engine';
import chalk from 'chalk';

export const spawnSubAgentTool = tool({
    description: 'Spawns a new, independent AI sub-agent to handle a complex or time-consuming sub-task. Use this when you have a large goal that can be broken down into steps, and you want to delegate a piece of it to avoid cluttering your own memory context. The sub-agent runs in the same workspace but with a clean memory slate.',
    inputSchema: z.object({
        task: z.string().describe('The detailed instructions or prompt to give to the sub-agent.'),
        subAgentId: z.string().describe('A unique identifier for this sub-agent (e.g. "auth_builder"). Used to keep its memory separate.')
    }),
    execute: async ({ task, subAgentId }: { task: string, subAgentId: string }): Promise<string> => {
        try {
            if (!task || !subAgentId) return 'Error: You must provide valid task and subAgentId strings.';
            console.log(chalk.magenta(`\n[SPAWNING SUB-AGENT: ${subAgentId}]`));
            console.log(chalk.gray(`Sub-Task: ${task}\n`));

            const engine = new AgentEngine({ memoryId: subAgentId, prefix: `[SUB:${subAgentId}] ` });

            const finalResult = await engine.run(task);

            console.log(chalk.magenta(`\n[SUB-AGENT ${subAgentId} COMPLETED]`));
            return `Sub-agent ${subAgentId} completed its task. Final report:\n${finalResult}`;
        } catch (error: any) {
            return `Sub-agent ${subAgentId} crashed: ${error.message}`;
        }
    },
});
