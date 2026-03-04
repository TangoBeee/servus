import { useState } from 'react'
import './App.css'

const features = [
  {
    icon: '🧠',
    color: 'green',
    title: 'ReAct Loop Agent',
    desc: 'Observe, Think, Act. Servus reasons through problems autonomously using a continuous feedback loop powered by the Vercel AI SDK.'
  },
  {
    icon: '🔌',
    color: 'purple',
    title: 'Multi-Provider LLM',
    desc: 'Switch between OpenAI, Anthropic Claude, and Google Gemini with a single config change. No code modifications needed.'
  },
  {
    icon: '💾',
    color: 'cyan',
    title: 'Persistent Memory',
    desc: 'Session context is serialized to .servus/memory.json. Restart the CLI and pick up exactly where you left off.'
  },
  {
    icon: '🤖',
    color: 'blue',
    title: 'Sub-Agent Delegation',
    desc: 'Complex tasks are automatically broken into isolated sub-agents that run in parallel with their own memory and context.'
  },
  {
    icon: '👁️',
    color: 'yellow',
    title: 'Watch Mode',
    desc: 'Run with --watch to monitor your workspace. Servus automatically re-evaluates and acts when your codebase changes.'
  },
  {
    icon: '⚡',
    color: 'red',
    title: 'Live Interrupt',
    desc: 'Press "i" at any time to pause the agent mid-thought, inject new instructions, and redirect its execution in real-time.'
  }
]

function App() {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText('npm install && npx ts-node src/index.ts "your task"')
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="page-wrapper">
      {/* Navbar */}
      <nav className="navbar">
        <a href="#" className="navbar-logo">SERVUS<span>.ai</span></a>
        <div className="navbar-links">
          <a href="#features">Features</a>
          <a href="#install">Install</a>
          <a
            href="https://github.com/TangoBeee/servus"
            target="_blank"
            rel="noopener noreferrer"
            className="github-btn"
          >
            ⭐ GitHub
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-badge">
          <span className="dot"></span>
          Open Source &middot; MIT License
        </div>
        <h1>
          Your Terminal's<br />
          <span className="gradient-text">AI Engineer</span>
        </h1>
        <p className="hero-subtitle">
          Servus is an autonomous CLI agent that reads your codebase, writes code,
          runs tests, and self-heals — all from a single command.
        </p>
        <div className="hero-actions">
          <a href="#install" className="btn-primary">
            Get Started →
          </a>
          <a
            href="https://github.com/TangoBeee/servus"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
          >
            View on GitHub
          </a>
        </div>
      </section>

      {/* Terminal Demo */}
      <section className="terminal-section">
        <div className="terminal-window">
          <div className="terminal-header">
            <span className="terminal-dot red"></span>
            <span className="terminal-dot yellow"></span>
            <span className="terminal-dot green"></span>
            <span className="terminal-title">servus — zsh</span>
          </div>
          <div className="terminal-body">
            <div className="terminal-line">
              <span className="t-prompt">$ </span>
              <span className="t-command">servus "Build a REST API with Express"</span>
            </div>
            <div className="terminal-line t-dim">&nbsp;</div>
            <div className="terminal-line t-green">
              ╔═══════════════════════════════════╗
            </div>
            <div className="terminal-line t-green">
              ║&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;S E R V U S&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;║
            </div>
            <div className="terminal-line t-green">
              ╚═══════════════════════════════════╝
            </div>
            <div className="terminal-line t-dim">&nbsp;</div>
            <div className="terminal-line">
              <span className="t-green">✔ </span>
              <span className="t-dim">Agent is synchronizing synapses (Step 1)...</span>
            </div>
            <div className="terminal-line">
              <span className="t-cyan">[ACT] Executing Sequence: </span>
              <span className="t-command">write_file</span>
            </div>
            <div className="terminal-line t-dim">
              &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Payload: {`{"filePath": "server.js"}`}
            </div>
            <div className="terminal-line">
              <span className="t-green">✔ </span>
              <span className="t-dim">Agent is synchronizing synapses (Step 2)...</span>
            </div>
            <div className="terminal-line">
              <span className="t-cyan">[ACT] Executing Sequence: </span>
              <span className="t-command">execute_terminal_command</span>
            </div>
            <div className="terminal-line t-dim">
              &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Payload: {`{"command": "node server.js"}`}
            </div>
            <div className="terminal-line t-dim">&nbsp;</div>
            <div className="terminal-line">
              <span className="t-green">✔ TASK COMPLETE</span>
              <span className="t-cursor"></span>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="features" id="features">
        <div className="section-header">
          <h2>Built for Autonomy</h2>
          <p>
            Everything you need to let AI handle the heavy lifting in your terminal.
          </p>
        </div>
        <div className="features-grid">
          {features.map((f, i) => (
            <div className="feature-card" key={i}>
              <div className={`feature-icon ${f.color}`}>{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Install */}
      <section className="install-section" id="install">
        <div className="section-header">
          <h2>Get Started in Seconds</h2>
          <p>Clone, install, and run your first task.</p>
        </div>
        <div className="install-box">
          <span className="dollar">$</span>
          <code>npm install && npx ts-node src/index.ts "your task"</code>
          <button onClick={handleCopy}>{copied ? '✓' : 'Copy'}</button>
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <p>
          Built with ☕ by{' '}
          <a href="https://github.com/TangoBeee" target="_blank" rel="noopener noreferrer">
            @TangoBeee
          </a>{' '}
          · MIT License ·{' '}
          <a href="https://github.com/TangoBeee/servus" target="_blank" rel="noopener noreferrer">
            Star on GitHub
          </a>
        </p>
      </footer>
    </div>
  )
}

export default App
