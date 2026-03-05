#!/usr/bin/env node
import 'dotenv/config';
import * as fs from 'fs';
import { Command } from 'commander';
import chalk from 'chalk';
import boxen from 'boxen';
import { AgentEngine } from './agent/engine';
import { ConfigManager } from './config';
import { agentTools } from './tools';

const program = new Command();
const config = new ConfigManager();

program
    .name('servus')
    .description('Servus - Autonomous CLI-based AI coding agent')
    .version('1.0.0');

program
    .argument('[task]', 'The task for Servus to accomplish')
    .option('-w, --watch', 'Continuously run the agent when files in the workspace change')
    .action(async (task?: string, options?: { watch?: boolean }) => {

        // Clear the viewport to simulate full screen, but preserve scrollback
        process.stdout.write('\x1b[2J\x1b[H');

        // Hacker theme startup logo
        console.log(
            boxen(chalk.green.bold('S E R V U S\n') + chalk.gray('Autonomous Agent Initialization Protocol...'), {
                padding: 1,
                margin: 1,
                borderStyle: 'double',
                borderColor: 'green',
                align: 'center'
            })
        );

        // Trigger setup if new
        await config.runInitialSetup();

        // Use configured workspace
        const workspace = config.get('workspace') as string;
        try {
            process.chdir(workspace);
        } catch (e) {
            console.error(chalk.red(`Failed to change directory to ${workspace}. Falling back to ${process.cwd()}`));
        }

        console.log(chalk.gray(`[SYS] Workspace bounded to: ${process.cwd()}`));
        console.log(chalk.gray(`[SYS] Configuration Loaded: defaultModel=${config.get('defaultModel')}`));

        const engine = new AgentEngine();

        if (task) {
            console.log(chalk.cyan(`\n[+] Task injected: "${task}"`));
            console.log(chalk.gray('--------------------------------------------------'));

            await engine.run(task);

            if (options?.watch) {
                console.log(chalk.yellow('\n[WS] Watch mode engaged. Monitoring workspace for changes...'));

                let isRunning = false;
                let debounceTimer: NodeJS.Timeout | null = null;

                fs.watch(process.cwd(), { recursive: true }, (eventType, filename) => {
                    // Ignore memory file changes to prevent infinite recursive self-triggering
                    if (filename && filename.includes('.servus')) return;
                    if (filename && filename.includes('node_modules')) return;
                    if (filename && filename.includes('.git')) return;

                    if (debounceTimer) clearTimeout(debounceTimer);

                    debounceTimer = setTimeout(async () => {
                        if (isRunning) return; // Prevent concurrent overlapping runs
                        isRunning = true;

                        console.log(chalk.cyan(`\n[WS] Event detected in ${filename}. Re-evaluating task: "${task}"`));
                        console.log(chalk.gray('--------------------------------------------------'));

                        try {
                            await engine.run(task);
                        } catch (e: any) {
                            console.error(chalk.red(`[FATAL] Uncaught error during watch execution: ${e.message}`));
                        } finally {
                            isRunning = false;
                            console.log(chalk.yellow('\n[WS] Returning to standby watch...'));
                        }
                    }, 2000); // 2 second debounce for multi-file saves like git pull
                });
            }
        } else {
            console.log(chalk.yellow('\n[+] Entering Interactive REPL Override (Ctrl+C to format module)'));
            await engine.repl();
        }
    });

program.parse();
