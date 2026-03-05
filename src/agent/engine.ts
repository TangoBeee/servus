import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import chalk from 'chalk';
import boxen from 'boxen';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { agentTools } from '../tools';
import { SYSTEM_PROMPT } from '../llm/client';
import { ConfigManager } from '../config';

const MAX_CONTEXT_LENGTH = 50;

// Define our own basic message type compatible with ai SDK
export type AgentMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

export class AgentEngine {
    private messages: AgentMessage[] = [];
    private config: ConfigManager;
    private recentErrors: string[] = [];
    private memoryPath: string;
    private prefix: string;

    constructor(options: { memoryId?: string, prefix?: string } = {}) {
        this.config = new ConfigManager();
        this.prefix = options.prefix || '';
        const memoryFileName = options.memoryId ? `memory_${options.memoryId}.json` : 'memory.json';
        this.memoryPath = path.join(process.cwd(), '.servus', memoryFileName);
        this.loadMemory();
    }

    private loadMemory() {
        try {
            if (fs.existsSync(this.memoryPath)) {
                const raw = fs.readFileSync(this.memoryPath, 'utf8');
                const loadedMessages = JSON.parse(raw);
                this.messages = [
                    { role: 'system', content: SYSTEM_PROMPT },
                    ...loadedMessages
                ];
                console.log(chalk.gray(`${this.prefix}[SYS] Restored ${loadedMessages.length} persistent memory sequences.`));
            } else {
                this.messages = [
                    { role: 'system', content: SYSTEM_PROMPT }
                ];
            }
        } catch (e) {
            console.error(chalk.red(`${this.prefix}Failed to load memory, starting fresh.`));
            this.messages = [
                { role: 'system', content: SYSTEM_PROMPT }
            ];
        }
    }

    private saveMemory() {
        try {
            const dir = path.dirname(this.memoryPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const memoryToSave = this.messages.filter(m => m.role !== 'system');
            fs.writeFileSync(this.memoryPath, JSON.stringify(memoryToSave, null, 2), 'utf8');
        } catch (e) {
            // Silently fail to not interrupt task if memory write issues occur
        }
    }

    private trimContext() {
        if (this.messages.length > MAX_CONTEXT_LENGTH) {
            const systemPrompt = this.messages[0];
            const recentMessages = this.messages.slice(-(MAX_CONTEXT_LENGTH - 1));
            this.messages = [systemPrompt, ...recentMessages];
            this.saveMemory();
        }
    }

    async run(task: string): Promise<string> {
        this.messages.push({ role: 'user', content: task });
        this.saveMemory();

        // Dynamic imports
        const oraOpts = await import('ora');
        const oraFn = (oraOpts as any).default || oraOpts;
        const spinner = oraFn({ stream: process.stdout });

        let iterations = 0;
        let finalResultText = '';

        let isInterrupted = false;
        let currentAbortController: AbortController | null = null;

        const handleKeypress = (str: string, key: any) => {
            if (key.sequence === '\u0003' || (key.ctrl && key.name === 'c')) {
                process.exit();
            }
            if (key.name === 'i' && !isInterrupted) {
                isInterrupted = true;
                if (currentAbortController) {
                    currentAbortController.abort();
                }
            }
        };

        if (process.stdin.isTTY) {
            readline.emitKeypressEvents(process.stdin);
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('keypress', handleKeypress);
        }

        console.log(chalk.gray(`${this.prefix}[TIP] Press 'i' at any time to interrupt and inject new context.`));

        while (true) {
            iterations++;
            this.trimContext();

            spinner.text = chalk.green(`${this.prefix}Agent is synchronizing synapses (Step ${iterations})...`);
            spinner.start();

            if (isInterrupted) {
                spinner.stop();
                if (process.stdin.isTTY) process.stdin.setRawMode(false);
                process.stdin.off('keypress', handleKeypress);

                const Enquirer = (await import('enquirer')).default;
                console.log(chalk.yellow(`\n${this.prefix}[SYS] Agent paused. Inject new context (or press Enter to resume):`));
                const prompt: any = await Enquirer.prompt({
                    type: 'input',
                    name: 'ctx',
                    message: chalk.magenta.bold('>')
                });

                if (prompt.ctx.trim()) {
                    this.messages.push({ role: 'user', content: `[SYSTEM INTERRUPT / NEW CONTEXT]: ${prompt.ctx.trim()}` });
                    this.saveMemory();
                    console.log(chalk.cyan(`[+] Injected new context into memory.`));
                }

                if (process.stdin.isTTY) {
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                    process.stdin.on('keypress', handleKeypress);
                }
                isInterrupted = false;
                continue; // Restart the loop with new context
            }

            try {
                const modelName = this.config.get('defaultModel') || 'gpt-4.1-nano';

                const toolsWithoutExecute = Object.fromEntries(
                    Object.entries(agentTools).map(([key, toolSpec]) => {
                        const { execute, ...rest } = toolSpec as any;
                        return [key, rest];
                    })
                );

                currentAbortController = new AbortController();

                const getProvider = (model: string) => {
                    if (model.startsWith('claude')) return anthropic(model);
                    if (model.startsWith('gemini')) return google(model);
                    return openai(model);
                };

                const result = await generateText({
                    model: getProvider(modelName),
                    messages: this.messages as any,
                    tools: toolsWithoutExecute,
                    abortSignal: currentAbortController.signal,
                });

                spinner.stopAndPersist({ symbol: chalk.green('✔') });
                // Clear recent errors on successful step
                this.recentErrors = [];

                const hasToolCalls = result.toolCalls && result.toolCalls.length > 0;

                if (result.text) {
                    if (hasToolCalls) {
                        console.log(
                            boxen(chalk.italic.yellow(result.text), {
                                title: chalk.yellow(`${this.prefix}🧠 Inner Monologue`),
                                titleAlignment: 'left',
                                padding: 0,
                                margin: { top: 1, bottom: 1, left: 0, right: 0 },
                                borderStyle: 'round',
                                borderColor: 'yellow'
                            })
                        );
                    }
                    // Append assistant thought
                    this.messages.push({ role: 'assistant', content: result.text });
                    this.saveMemory();
                }

                if (hasToolCalls) {
                    for (const tc of result.toolCalls) {
                        const toolArgs = (tc as any).args || (tc as any).input || {};
                        console.log(chalk.cyan(`${this.prefix}[ACT] Executing Sequence: `) + chalk.cyan.bold(tc.toolName));
                        console.log(chalk.gray(`${this.prefix}      Payload: ${JSON.stringify(toolArgs)}`));

                        // Execute tool manually (spinner remains stopped)
                        const toolFunc = (agentTools as any)[tc.toolName].execute;
                        const toolResult = await toolFunc(toolArgs, {});

                        console.log(chalk.gray(`${this.prefix}      Observation: ${typeof toolResult === 'string' ? toolResult.slice(0, 100) + '...' : 'Success'}`));

                        // Feed observation back
                        this.messages.push({
                            role: 'user',
                            content: `Tool ${tc.toolName} returned:\n${toolResult}`
                        });
                        this.saveMemory();
                    }
                } else {
                    // No tool calls — the agent said something in text.
                    // Prompt the user for follow-up instead of exiting immediately.
                    console.log(
                        boxen(chalk.white(result.text), {
                            padding: 1,
                            margin: 1,
                            borderStyle: 'bold',
                            borderColor: 'green'
                        })
                    );

                    // Pause raw mode so enquirer can read input normally
                    if (process.stdin.isTTY) process.stdin.setRawMode(false);
                    process.stdin.off('keypress', handleKeypress);

                    const Enquirer = (await import('enquirer')).default;
                    const followUp: any = await Enquirer.prompt({
                        type: 'input',
                        name: 'reply',
                        message: chalk.cyan.bold('Your reply (Enter to finish)')
                    });

                    // Restore raw mode
                    if (process.stdin.isTTY) {
                        process.stdin.setRawMode(true);
                        process.stdin.resume();
                        process.stdin.on('keypress', handleKeypress);
                    }

                    if (!followUp.reply || !followUp.reply.trim()) {
                        finalResultText = result.text;
                        break; // User pressed Enter with no input — exit
                    }

                    // Inject user's reply and continue the loop
                    this.messages.push({ role: 'user', content: followUp.reply.trim() });
                    this.saveMemory();
                }

            } catch (error: any) {
                spinner.stop();

                if (isInterrupted || error.name === 'AbortError') {
                    // Handled at the top of the loop
                    continue;
                }

                spinner.stopAndPersist({ symbol: chalk.red('✖') });
                console.log(
                    boxen(chalk.red.bold(`${this.prefix}EXCEPTION (Retrying):\n\n`) + chalk.red(error.message), {
                        padding: 1,
                        borderStyle: 'single',
                        borderColor: 'red'
                    })
                );

                // Track consecutive identical errors
                this.recentErrors.push(error.message);

                if (this.recentErrors.length >= 3) {
                    console.log(chalk.red.bold(`\n${this.prefix}[FATAL] Detected recurring identical errors. Breaking loop to prevent infinite retry.`));
                    finalResultText = `Failed with recurring error: ${error.message}`;
                    break;
                }

                this.messages.push({ role: 'user', content: `Execution error occurred: ${error.message}. Please fix it and retry.` });
                this.saveMemory();
            }
        }

        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
            process.stdin.off('keypress', handleKeypress);
        }
        process.stdin.pause();

        return finalResultText;
    }

    async repl() {
        const Enquirer = (await import('enquirer')).default;
        while (true) {
            try {
                const prompt: any = await Enquirer.prompt({
                    type: 'input',
                    name: 'cmd',
                    message: chalk.magenta.bold('root@servus:~#')
                });
                let cmd = prompt.cmd.trim();
                if (cmd.toLowerCase() === 'exit' || cmd.toLowerCase() === 'quit') break;
                if (!cmd) continue;

                if (cmd.toLowerCase() === 'clear_memory') {
                    if (fs.existsSync(this.memoryPath)) fs.unlinkSync(this.memoryPath);
                    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
                    console.log(chalk.green('[SYS] Persistent memory cleared.'));
                    continue;
                }

                await this.run(cmd);
            } catch (error) {
                break;
            }
        }
    }
}
