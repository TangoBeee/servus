import { tool } from 'ai';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

export const readFileTool = tool({
    description: 'Reads the contents of a specific file. Useful to investigate existing code.',
    inputSchema: z.object({
        filePath: z.string().describe('The absolute or relative path to the file to read.')
    }),
    execute: async ({ filePath }: { filePath: string }): Promise<string> => {
        try {
            if (!filePath) return 'Error: You must provide a valid filePath string.';
            const absPath = path.resolve(process.cwd(), filePath);
            const data = await fs.readFile(absPath, 'utf-8');
            return data;
        } catch (error: any) {
            return `Failed to read file: ${error.message}`;
        }
    },
});

export const writeFileTool = tool({
    description: 'Creates or overwrites a file with new content.',
    inputSchema: z.object({
        filePath: z.string().describe('The path to the file to write.'),
        content: z.string().describe('The entire content to write into the file.')
    }),
    execute: async ({ filePath, content }: { filePath: string, content: string }): Promise<string> => {
        try {
            if (!filePath) return 'Error: You must provide a valid filePath string.';
            const absPath = path.resolve(process.cwd(), filePath);
            await fs.mkdir(path.dirname(absPath), { recursive: true });
            await fs.writeFile(absPath, content, 'utf-8');
            return `Successfully wrote to ${filePath}`;
        } catch (error: any) {
            return `Failed to write file: ${error.message}`;
        }
    },
});

export const patchFileTool = tool({
    description: 'Edits specific parts of a file by replacing an exact search string with a new replace string. Crucial for large files without rewriting the whole thing.',
    inputSchema: z.object({
        filePath: z.string().describe('The path to the file to patch.'),
        searchString: z.string().describe('The exact string to find in the file.'),
        replaceString: z.string().describe('The string to replace the search string with.')
    }),
    execute: async ({ filePath, searchString: oldContent, replaceString: newContent }: { filePath: string, searchString: string, replaceString: string }): Promise<string> => {
        try {
            if (!filePath) return 'Error: You must provide a valid filePath string.';
            const absPath = path.resolve(process.cwd(), filePath);
            let data = await fs.readFile(absPath, 'utf-8');
            if (!data.includes(oldContent)) {
                return `Failed to patch: Could not find exact match for oldContent in ${filePath}.`;
            }
            data = data.replace(oldContent, newContent);
            await fs.writeFile(absPath, data, 'utf-8');
            return `Successfully patched ${filePath}`;
        } catch (error: any) {
            return `Failed to patch file: ${error.message}`;
        }
    },
});

export const listDirectoryTool = tool({
    description: 'Explores the file system by listing all files and directories in a given path.',
    inputSchema: z.object({
        dirPath: z.string().describe('The directory path to list. Use "." for current directory.')
    }),
    execute: async ({ dirPath }: { dirPath: string }): Promise<string> => {
        try {
            const targetDir = dirPath || '.';
            const fullPath = path.resolve(process.cwd(), targetDir);
            const entries = await fs.readdir(fullPath, { withFileTypes: true });
            const dirContents = entries.map((entry: any) => `${entry.isDirectory() ? '[DIR] ' : '[FILE]'} ${entry.name}`);
            return dirContents.join('\n');
        } catch (error: any) {
            return `Failed to list directory: ${error.message}`;
        }
    },
});
