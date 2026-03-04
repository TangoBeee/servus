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
        // If config has API keys, load them into env natively
        if (this.config.apiKey) process.env.OPENAI_API_KEY = this.config.apiKey;
        if (this.config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = this.config.anthropicApiKey;
        if (this.config.googleApiKey) process.env.GOOGLE_GENERATIVE_AI_API_KEY = this.config.googleApiKey;

        if (!this.isFirstRun) return;

        const Enquirer = (await import('enquirer')).default;
        console.log(chalk.green.bold('\n[+] Welcome to Servus! Initial setup required.\n'));

        const providerResp: any = await Enquirer.prompt({
            type: 'select',
            name: 'provider',
            message: 'Select your preferred AI Provider:',
            choices: ['OpenAI', 'Anthropic', 'Google']
        });

        if (providerResp.provider === 'OpenAI' && !process.env.OPENAI_API_KEY) {
            const apiResp: any = await Enquirer.prompt({ type: 'password', name: 'key', message: 'Enter your OpenAI API Key:' });
            this.set('apiKey', apiResp.key);
            process.env.OPENAI_API_KEY = apiResp.key;
            console.log(chalk.gray(`Saved OpenAI key to ~/.servusrc\n`));
        } else if (providerResp.provider === 'Anthropic' && !process.env.ANTHROPIC_API_KEY) {
            const apiResp: any = await Enquirer.prompt({ type: 'password', name: 'key', message: 'Enter your Anthropic API Key:' });
            this.set('anthropicApiKey', apiResp.key);
            process.env.ANTHROPIC_API_KEY = apiResp.key;
            console.log(chalk.gray(`Saved Anthropic key to ~/.servusrc\n`));
        } else if (providerResp.provider === 'Google' && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
            const apiResp: any = await Enquirer.prompt({ type: 'password', name: 'key', message: 'Enter your Google Gemini API Key:' });
            this.set('googleApiKey', apiResp.key);
            process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiResp.key;
            console.log(chalk.gray(`Saved Google key to ~/.servusrc\n`));
        }

        const defaultModels: Record<string, string> = {
            'OpenAI': 'gpt-4o',
            'Anthropic': 'claude-3-5-sonnet-latest',
            'Google': 'gemini-1.5-pro-latest'
        };

        const configResp: any = await Enquirer.prompt([
            {
                type: 'input',
                name: 'model',
                message: `Default ${providerResp.provider} Model to use?`,
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
        console.log(chalk.green.bold('\n[+] Setup complete!\n'));
    }
}
