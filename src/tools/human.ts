import { tool } from 'ai';
import { z } from 'zod';

export const askHumanTool = tool({
    description: 'Pauses execution to ask the user for clarification, passwords, or architectural decisions.',
    inputSchema: z.object({
        question: z.string().describe('The question or clarification needed from the human user.')
    }),
    execute: async ({ question }: { question: string }): Promise<string> => {
        if (!question) return 'Error: You must provide a valid question string.';

        // Dynamic import to work well with some ESM-only prompt libraries, though enquirer is CJS compatible usually.
        const Enquirer = (await import('enquirer')).default;

        try {
            const response: any = await Enquirer.prompt({
                type: 'input',
                name: 'answer',
                message: question,
            });
            return response.answer;
        } catch (error: any) {
            return `User canceled or error occurred: ${error.message} `;
        }
    },
});
