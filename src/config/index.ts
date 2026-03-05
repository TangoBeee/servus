import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export interface ServusConfig {
    defaultModel: string;
    theme: 'hacker' | 'minimal';
    workspace: string;
    apiKey?: string;
    anthropicApiKey?: string;
    googleApiKey?: string;
}

const defaultConfig: ServusConfig = {
    defaultModel: 'gpt-4o',
    theme: 'hacker',
    workspace: process.cwd(),
};

export class ConfigManager {
    private configPath: string;
    private config: ServusConfig;
    public isFirstRun: boolean = false;

    constructor() {
        // Determine the home directory in a cross-platform way
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        this.configPath = path.join(homeDir, '.servusrc');
        this.config = { ...defaultConfig };
        this.load();
    }

    private load() {
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, 'utf8');
                const parsed = JSON.parse(raw);
                this.config = { ...defaultConfig, ...parsed };
                if (!this.config.workspace) this.config.workspace = process.cwd();
            } else {
                this.isFirstRun = true;
                this.save();
            }
        } catch (error) {
            console.error('Failed to load ~/.servusrc config, using defaults.');
        }
    }

    private save() {
        try {
            fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
        } catch (error) {
            console.error('Failed to save ~/.servusrc config.');
        }
    }

    get(key: keyof ServusConfig) {
        return this.config[key];
    }

    set(key: keyof ServusConfig, value: any) {
        this.config[key] = value as never;
        this.save();
    }

    getAll() {
        return this.config;
    }

    async runInitialSetup() {
        // Keys come ONLY from ~/.servusrc — env vars are intentionally ignored.
        // This ensures consistent behaviour whether running locally or globally via npm.
        const storedKey = this.config.apiKey || this.config.anthropicApiKey || this.config.googleApiKey;

        if (!this.isFirstRun && storedKey) {
            // Push stored key to env so SDK picks it up
            if (this.config.apiKey) process.env.OPENAI_API_KEY = this.config.apiKey;
            if (this.config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = this.config.anthropicApiKey;
            if (this.config.googleApiKey) process.env.GOOGLE_GENERATIVE_AI_API_KEY = this.config.googleApiKey;
            return;
        }

        const Enquirer = (await import('enquirer')).default;
        console.log(chalk.green.bold('\n[+] Welcome to Servus! Let\'s get you set up.\n'));

        const providerResp: any = await Enquirer.prompt({
            type: 'select',
            name: 'provider',
            message: 'Select your preferred AI Provider:',
            choices: ['OpenAI', 'Anthropic', 'Google']
        });

        const keyMessages: Record<string, string> = {
            'OpenAI': 'Enter your OpenAI API Key:',
            'Anthropic': 'Enter your Anthropic API Key:',
            'Google': 'Enter your Google Gemini API Key:'
        };

        const apiResp: any = await Enquirer.prompt({
            type: 'password',
            name: 'key',
            message: keyMessages[providerResp.provider]
        });

        if (!apiResp.key || !apiResp.key.trim()) {
            console.log(chalk.red('[!] No API key entered. Exiting.'));
            process.exit(1);
        }

        // Store key in ~/.servusrc and inject into env for this session
        if (providerResp.provider === 'OpenAI') {
            this.set('apiKey', apiResp.key.trim());
            process.env.OPENAI_API_KEY = apiResp.key.trim();
        } else if (providerResp.provider === 'Anthropic') {
            this.set('anthropicApiKey', apiResp.key.trim());
            process.env.ANTHROPIC_API_KEY = apiResp.key.trim();
        } else if (providerResp.provider === 'Google') {
            this.set('googleApiKey', apiResp.key.trim());
            process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiResp.key.trim();
        }
        console.log(chalk.gray(`[+] API key saved to ~/.servusrc\n`));

        const defaultModels: Record<string, string> = {
            'OpenAI': 'gpt-4o',
            'Anthropic': 'claude-3-5-sonnet-latest',
            'Google': 'gemini-1.5-pro-latest'
        };

        const configResp: any = await Enquirer.prompt([
            {
                type: 'input',
                name: 'model',
                message: `Default ${providerResp.provider} model to use?`,
                initial: defaultModels[providerResp.provider]
            },
            {
                type: 'input',
                name: 'workspace',
                message: 'Default workspace directory?',
                initial: process.cwd()
            }
        ]);

        this.set('defaultModel', configResp.model);
        this.set('workspace', configResp.workspace);
        this.isFirstRun = false;
        console.log(chalk.green.bold('\n[+] Setup complete! You\'re good to go.\n'));
    }
}
