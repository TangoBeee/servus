import React, { useState, useEffect, useRef, useCallback } from 'react'
import toast, { Toaster } from 'react-hot-toast'
import './index.css'

const ASCII_GLOBE = `
      .:::::::..
    .::::::::::::.
   :::::::' \`::::::
  :::::::    :::::::
  :::::::    :::::::
   ::::::.. .::::::
    \`::::::::::::'
      \`':::::::'\`
`;

const ASCII_AGENTIC_LOOP = `
   [ PLAN ] ──→ [ ACT ]
      ↑            │
      │            ↓
 [ OBSERVE ] ←─ [ THINK ]
`;

const ASCII_SHIELD = `
   [ USER TASK ]
          │
  [ SERVUS RUNTIME ]
          │
   [ DOMAIN TOOLS ]
`;

const ASCII_PLANE = `              .------,
              =\\      \\
 .---.         =\\      \\
 | C~ \\         =\\      \\
 |     \`----------'------'----------,
.'     LI.-.LI LI LI LI LI LI LI.-.LI\`-.
\\ _/.____|_|______.------,______|_|_____)
                 /      /
               =/      /
              =/      /
             =/      /
             /_____,'`;

const ASCII_NUKE = `⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠠⠒⢂⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⣙⣄⠀⠀⠱⡀⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⡠⠤⠾⣻⢂⠀⠀⠐⠄⠀
⠀⠀⠀⠀⠀⠀⠀⡠⠐⠨⡁⠀⠀⠀⠀⠙⣖⣥⡀⠀⠈⢆
⠀⠀⠀⠀⡠⠐⠁⠀⠀⠀⠐⠄⠀⠀⠀⡠⠊⠹⡑⡤⠐⠉
⠀⡠⢆⠁⠀⢠⢆⣗⢦⠀⠀⠈⢂⢀⠔⠀⠀⠀⠀⠀⠀⠀
⡘⠀⠈⢢⠀⠘⠯⠭⠟⠀⠀⡠⠔⠁⠀⠀⠀⠀⠀⠀⠀⠀
⢃⠀⠀⠀⠱⡀⠀⠀⡠⠐⠉⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠢⠄⣀⣀⠰⠐⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀`;


// --- Synthetic Audio Engine ---
const playPropellerSound = (ctx, duration) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(40, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(45, ctx.currentTime + duration / 2);
  osc.frequency.linearRampToValueAtTime(35, ctx.currentTime + duration);

  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + duration / 2);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
};

const playBombDropSound = (ctx, duration) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + duration);

  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration);
};

const playExplosionSound = (ctx) => {
  const bufferSize = ctx.sampleRate * 2.5;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  const noiseSource = ctx.createBufferSource();
  noiseSource.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(1000, ctx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(10, ctx.currentTime + 2.5);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 2.5);

  noiseSource.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  noiseSource.start();
};

const delay = ms => new Promise(res => setTimeout(res, ms));

function Console({
  onClose, history, setHistory, commandHistory, setCommandHistory, isRoot, setIsRoot, setIsHacked, setIsNuking, audioRef, isPlaying, setIsPlaying, musicVolume, setMusicVolume
}) {
  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isProcessing, setIsProcessing] = useState(false);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  // Draggable State
  const [position, setPosition] = useState({ x: window.innerWidth - 650, y: 80 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  useEffect(() => {
    if (!isProcessing) {
      inputRef.current?.focus();
    }
  }, [isProcessing, history]);

  const handleMouseDown = (e) => {
    setIsDragging(true);
    setDragOffset({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isDragging) setPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  const handleKeyDown = (e) => {
    if (isProcessing) {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex < commandHistory.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setInput(commandHistory[commandHistory.length - 1 - nextIndex]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setInput(commandHistory[commandHistory.length - 1 - nextIndex]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const baseCommands = ['help', 'about', 'start', 'clear', 'echo', 'date', 'whoami', 'pwd', 'ls', 'cat', 'sudo', 'hack', 'ping', 'contact'];
      const rootCommands = ['nuke'];
      const availableCommands = isRoot ? [...baseCommands, ...rootCommands] : baseCommands;
      const current = input.toLowerCase();

      if (current === 'sudo ' || current === 'sudo s') { setInput('sudo su'); return; }
      if (current === 'sudo r') { setInput('sudo rm -rf /'); return; }
      if (current === 'ls ' || current === 'ls a') { setInput('ls agents/'); return; }
      if (current === 'cat ' || current === 'cat c') { setInput('cat config.json'); return; }
      if (current === 'cat t' && isRoot) { setInput('cat top_secret_data.txt'); return; }

      const match = availableCommands.find(cmd => cmd.startsWith(current));
      if (match) setInput(match);
    }
  };

  const handleCommandSubmit = async (e) => {
    e.preventDefault();
    if (isProcessing) return;
    const cmd = input.trim();
    if (!cmd) return;

    setHistory(prev => [...prev, { type: 'user', content: cmd, isRoot }]);
    setCommandHistory(prev => [...prev, cmd]);
    setHistoryIndex(-1);
    setInput('');
    setIsProcessing(true);

    const args = cmd.split(' ');
    const command = args[0].toLowerCase();

    // Sudo Easter Eggs
    if (command === 'sudo' && args[1] === 'su') {
      setIsRoot(true);
      setHistory(prev => [...prev, { type: 'system', content: 'Bypassing mainframe security... Access Granted. You are now root.' }]);
    }
    else if (command === 'sudo' && args[1] === 'rm' && args[2] === '-rf') {
      setHistory(prev => [...prev, { type: 'system', content: 'Nice try! I am an AI, I don\'t have a physical filesystem to delete. 🤖 Nice prank though.' }]);
    }

    // Commands
    else if (command === 'help') {
      setHistory(prev => [...prev, { type: 'system', content: 'Commands: help, about, start, clear, echo, date, whoami, ls, cat, pwd, ping, hack, contact, music play, music stop, music volume <0-100>' + (isRoot ? ', nuke' : '') }]);
    } else if (command === 'clear') {
      setHistory([]);
    } else if (command === 'about') {
      setHistory(prev => [...prev, { type: 'system', content: 'Servus OS: a local-first, multi-capability AI agent for coding, browser workflows, desktop files, data/docs, media, security analysis, and custom skills/plugins.' }]);
    } else if (command === 'start') {
      setHistory(prev => [...prev, { type: 'system', content: 'Initializing Servus runtime...' }]);
      await delay(600);
      setHistory(prev => [...prev, { type: 'system', content: '[OK] Runtime contracts + evidence validator online' }]);
      await delay(400);
      setHistory(prev => [...prev, { type: 'system', content: '[OK] Loaded domain engines: coding, browser, desktop, media, data, security, extension, general' }]);
      await delay(400);
      setHistory(prev => [...prev, { type: 'system', content: '[OK] Browser memory, skills/plugins, proof collection, and consent gates ready' }]);
      await delay(600);
      setHistory(prev => [...prev, { type: 'system', content: '=> READY. Tasks complete only when evidence satisfies the runtime contract.' }]);
    } else if (command === 'ping') {
      const target = args[1] || 'tangobee.dev';
      setHistory(prev => [...prev, { type: 'system', content: `PING ${target} (HTTP HEAD): measuring latency` }]);
      for (let i = 1; i <= 4; i++) {
        const start = performance.now();
        try {
          await fetch(`https://${target}`, { mode: 'no-cors', cache: 'no-store' });
          const end = performance.now();
          const latency = (end - start).toFixed(2);
          setHistory(prev => [...prev, { type: 'system', content: `Reply from ${target}: time=${latency}ms` }]);
        } catch {
          setHistory(prev => [...prev, { type: 'system', content: `Request timed out for ${target}` }]);
        }
        await delay(800);
      }
    } else if (command === 'echo') {
      setHistory(prev => [...prev, { type: 'system', content: args.slice(1).join(' ') }]);
    } else if (command === 'date') {
      setHistory(prev => [...prev, { type: 'system', content: new Date().toString() }]);
    } else if (command === 'whoami') {
      setHistory(prev => [...prev, { type: 'system', content: isRoot ? 'root (Superuser)' : 'guest@servus-os' }]);
    } else if (command === 'pwd') {
      setHistory(prev => [...prev, { type: 'system', content: isRoot ? '/root' : '/home/guest/servus' }]);
    } else if (command === 'ls') {
      const dir = args[1] ? args[1].replace(/\/$/, '') : '.';
      const fileSystem = {
        '.': ['engines/', 'tools/', 'runtime.ts', 'config.json', 'skills/', 'plugins/'],
        'engines': ['coding.ts', 'browser.ts', 'desktop.ts', 'media.ts', 'data.ts', 'security.ts', 'extension.ts', 'general.ts'],
        'tools': ['tools-playwright.ts', 'tools-desktop.ts', 'tools-media.ts', 'tools-data.ts', 'tools-security.ts', 'tools-extension.ts'],
        'src': ['index.ts', 'runtime.ts', 'agent.ts']
      };
      if (fileSystem[dir]) {
        let content = fileSystem[dir].join('  ');
        if (isRoot && dir === '.') content += '  top_secret_data.txt';
        setHistory(prev => [...prev, { type: 'system', content }]);
      } else {
        setHistory(prev => [...prev, { type: 'system', content: `ls: cannot access '${args[1]}': No such file or directory` }]);
      }
    } else if (command === 'cat') {
      const file = args[1];
      if (!file) {
        setHistory(prev => [...prev, { type: 'system', content: 'cat: missing file operand' }]);
      } else if (file === 'config.json') {
        setHistory(prev => [...prev, { type: 'system', content: `{\n  "name": "servus",\n  "version": "${__APP_VERSION__}",\n  "runtime": "strict-evidence",\n  "domains": ["coding", "browser", "desktop", "media", "data", "security", "extension", "general"]\n}` }]);
      } else if (file === 'top_secret_data.txt') {
        if (isRoot) setHistory(prev => [...prev, { type: 'system', content: 'TOP SECRET: The AI is actually just 10,000 nested if-statements. Shhh.' }]);
        else setHistory(prev => [...prev, { type: 'system', content: 'cat: top_secret_data.txt: Permission denied' }]);
      } else {
        setHistory(prev => [...prev, { type: 'system', content: `cat: ${file}: No such file or directory` }]);
      }
    } else if (command === 'hack') {
      setIsHacked(true);
      setHistory(prev => [...prev, { type: 'system', content: '>>> SAFE SIMULATION ONLY. No real systems touched.\nUnlocking hidden website components...' }]);
    } else if (command === 'contact') {
      setHistory(prev => [...prev, { type: 'system', content: '>>> Opening communication channel...\nEmail: tangobeee@gmail.com\nWebsite: https://tangobee.dev/servus\nGitHub: github.com/TangoBeee\nFeel free to reach out for Pro plans or customizations!' }]);
    } else if (command === 'music') {
      const musicCmd = args[1];
      if (musicCmd === 'play') {
        if (audioRef.current) {
          audioRef.current.play();
          setIsPlaying(true);
          setHistory(prev => [...prev, { type: 'system', content: '🎵 Now playing: Pixelland by Kevin MacLeod\nhttps://www.youtube.com/watch?v=rQqr10MC_uw' }]);
        }
      } else if (musicCmd === 'stop') {
        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current.currentTime = 0;
          setIsPlaying(false);
          setHistory(prev => [...prev, { type: 'system', content: '⏹️ Music stopped.' }]);
        }
      } else if (musicCmd === 'volume') {
        const vol = parseInt(args[2]);
        if (!isNaN(vol) && vol >= 0 && vol <= 100) {
          setMusicVolume(vol);
          if (audioRef.current) audioRef.current.volume = vol / 100;
          setHistory(prev => [...prev, { type: 'system', content: `🔊 Volume set to ${vol}%` }]);
        } else {
          setHistory(prev => [...prev, { type: 'system', content: 'Invalid volume. Use: music volume <0-100>' }]);
        }
      } else {
        setHistory(prev => [...prev, { type: 'system', content: 'Music commands: play, stop, volume <0-100>' }]);
      }
    } else if (command === 'nuke') {
      if (isRoot) {
        setHistory(prev => [...prev, { type: 'system', content: 'WARNING: TACTICAL NUKE INBOUND. DESTROYING UI...' }]);
        await delay(1000);
        onClose();
        setIsNuking(true);
      } else {
        setHistory(prev => [...prev, { type: 'system', content: 'Permission denied. You must be root to nuke.' }]);
      }
    } else {
      setHistory(prev => [...prev, { type: 'system', content: `Command not found: ${command}` }]);
    }

    setIsProcessing(false);
  };

  const promptChar = isRoot ? '#' : '$';

  return (
    <div className="console-overlay animating-in" style={{ left: position.x, top: position.y }}>
      <div className="console-header" onMouseDown={handleMouseDown}>
        <span>~/servus/console {isRoot ? '[ROOT]' : ''}</span>
        <span className="console-close" onMouseDown={(e) => { e.stopPropagation(); onClose(); }}>[X] CLOSE</span>
      </div>
      <div className="console-body" onClick={() => inputRef.current?.focus()}>
        {history.map((h, i) => (
          <div key={i} style={{ marginBottom: '4px' }}>
            {h.type === 'user' ? (
              <div><span className="t-prompt">{h.isRoot ? '#' : '$'}</span>{h.content}</div>
            ) : (
              <div style={{ color: h.content?.toString().includes('Permission denied') || h.content?.toString().includes('error') ? 'var(--text-dim)' : 'inherit', whiteSpace: 'pre-wrap' }}>{h.content}</div>
            )}
          </div>
        ))}
        {!isProcessing && (
          <form className="input-line" onSubmit={handleCommandSubmit}>
            <span className="t-prompt">{promptChar}</span>
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </form>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function PricingModal({ onClose, triggerContact }) {
  const [position, setPosition] = useState({ x: window.innerWidth / 2 - 400, y: Math.max(100, window.innerHeight / 2 - 250) });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e) => {
    setIsDragging(true);
    setDragOffset({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isDragging) setPosition({ x: e.clientX - dragOffset.x, y: e.clientY - dragOffset.y });
    };
    const handleMouseUp = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  return (
    <div className="console-overlay animating-in" style={{ left: position.x, top: position.y, width: '800px', height: 'auto', zIndex: 2000 }}>
      <div className="console-header" onMouseDown={handleMouseDown}>
        <span>~/servus/pricing.yml</span>
        <span className="console-close" onMouseDown={(e) => { e.stopPropagation(); onClose(); }}>[X] CLOSE</span>
      </div>
      <div className="console-body" style={{ padding: '2rem' }}>
        <h2 style={{ marginBottom: '1.5rem', fontSize: '2rem' }}>Subscription Plans</h2>
        <div style={{ display: 'flex', gap: '1.5rem' }}>
          <div className="fig-box" style={{ flex: 1, flexDirection: 'column', alignItems: 'flex-start' }}>
            <h3 style={{ borderBottom: 'var(--border)', paddingBottom: '0.5rem', width: '100%' }}>[ COMMUNITY ]</h3>
            <div style={{ margin: '1rem 0', fontSize: '2.5rem', fontWeight: 800 }}>$0<span style={{ fontSize: '1rem', color: 'var(--text-dim)' }}>/mo</span></div>
            <ul style={{ listStyle: 'none', color: 'var(--text-dim)', lineHeight: '1.8' }}>
              <li>+ Open Source CLI</li>
              <li>+ Bring Your Own Keys (Supported LLMs)</li>
              <li>+ Local Session + Proof Storage</li>
              <li>+ Strict Evidence Runtime</li>
            </ul>
          </div>
          <div className="fig-box pulse-border" style={{ flex: 1, flexDirection: 'column', alignItems: 'flex-start', background: 'rgba(255,255,255,0.05)' }}>
            <h3 style={{ borderBottom: 'var(--border)', paddingBottom: '0.5rem', width: '100%' }}>[ PRO ]</h3>
            <div style={{ margin: '1rem 0', fontSize: '2.5rem', fontWeight: 800 }}>$$$<span style={{ fontSize: '1rem', color: 'var(--text-dim)' }}>/custom</span></div>
            <ul style={{ listStyle: 'none', color: 'var(--text-main)', lineHeight: '1.8', flex: 1 }}>
              <li>+ Custom Skills / Plugin Integrations</li>
              <li>+ Team Setup & Workflow Design</li>
              <li>+ Security and Automation Playbooks</li>
              <li>+ Dedicated Implementation Support</li>
            </ul>
            <button
              onClick={() => { onClose(); triggerContact(); }}
              style={{ marginTop: '1.5rem', padding: '0.5rem 1rem', background: 'var(--text-main)', color: 'var(--bg-dark)', fontFamily: 'var(--font-mono)', fontWeight: 800, border: 'none', cursor: 'pointer', width: '100%' }}
            >
              [ CONTACT ME ]
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const BASE_DIRECTORY_FEED = [
  {
    date: '2026.4.27',
    title: 'Runtime-First Agent Reliability',
    content: 'Servus now routes work through a stricter execution contract.\n\n- Domains use understand → discover → plan → act → verify → finalize loops.\n- servus_done and servus_need_input finalization require evidence, confidence, and satisfied criteria.\n- Completion is rejected when proof is missing, ambiguous, stale, or contradicted.\n- Sessions persist events, artifacts, evidence, proof directories, and runtime status.'
  },
  {
    date: '2026.4.22',
    title: 'Desktop, Media, and Data Domains',
    content: 'Servus moved beyond coding while staying local-first.\n\n- Desktop tools perform ranked file discovery, exact path inspection, candidate selection, safe open/move/copy/trash, and post-action verification.\n- Media tools check ffmpeg/ffprobe/yt-dlp readiness and handle info, download, convert, trim, compress, audio extraction, and thumbnails.\n- Data & Docs tools extract PDF/DOCX text, parse CSV/TSV/XLS/XLSX tables, convert tables, and create report artifacts.'
  },
  {
    date: '2026.4.15',
    title: 'Persistent Browser Automation',
    content: 'Browser work now uses native Playwright with Servus session memory.\n\n- Browser sessions keep user data, current URL/title, cookies/storage, screenshots, snapshots, action history, and failed-action history.\n- Tools include snapshot, act, ref-based click/fill/select, coordinate fallback, scroll, extraction, screenshots, and explicit close.\n- Captchas, Cloudflare, login, payment, booking, posting, deletion, and other irreversible steps are treated as blockers or consent-gated actions.'
  },
  {
    date: '2026.4.05',
    title: 'Security and Extension Builder',
    content: 'Servus gained safer security workflows and local extensibility.\n\n- Cyber Security supports Offensive, Defensive, and Hybrid modes with safe recon, static scans, dependency/config/log checks, headers/TLS inspection, playbooks, and structured reports.\n- Extension Builder can scaffold project or user SKILL.md files and servus.plugin.json manifests from prompts.\n- Skills and plugin manifests load from bundled, project, user, and plugin sources; MCP server config is surfaced for the shared registry path.'
  }
];


function App() {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [expandedFeed, setExpandedFeed] = useState(null);

  // Game states
  const [isHacked, setIsHacked] = useState(false);
  const [isNuking, setIsNuking] = useState(false);
  const [nukeStage, setNukeStage] = useState(0);

  // Music states
  const [isPlaying, setIsPlaying] = useState(false);
  const [musicVolume, setMusicVolume] = useState(50);
  const audioRef = useRef(null);

  // Lifted Terminal State
  const [history, setHistory] = useState([
    { type: 'system', content: <div style={{ whiteSpace: 'pre', fontWeight: 800 }}>SERVUS OS TERMINAL v{__APP_VERSION__} — STRICT EVIDENCE RUNTIME</div> },
    { type: 'system', content: <div>Type 'help' to see available commands.</div> },
    { type: 'system', content: <br /> }
  ]);
  const [commandHistory, setCommandHistory] = useState([]);
  const [isRoot, setIsRoot] = useState(false);

  const triggerContactTerminal = useCallback(() => {
    setConsoleOpen(true);
    setHistory(prev => [
      ...prev,
      { type: 'user', content: 'contact', isRoot },
      { type: 'system', content: '>>> Opening communication channel...\nEmail: tangobeee@gmail.com\nWebsite: https://tangobee.dev/servus\nGitHub: github.com/TangoBeee\nFeel free to reach out for Pro plans or customizations!' }
    ]);
  }, [isRoot]);

  const triggerDocsTerminal = useCallback(() => {
    setConsoleOpen(true);
    setHistory(prev => [
      ...prev,
      { type: 'user', content: 'cat docs/index.md', isRoot },
      { type: 'system', content: '>>> Documentation is being updated to match the new runtime, domain engines, skills/plugins, and proof system. [ COMING SOON ]' }
    ]);
  }, [isRoot]);

  useEffect(() => {
    const handleKey = (e) => {
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;
      const key = e.key.toLowerCase();

      if (key === 'c') { e.preventDefault(); setConsoleOpen(prev => !prev); }
      if (key === 'g') { e.preventDefault(); window.open('https://github.com/TangoBeee/servus', '_blank'); }
      if (key === 'd') { e.preventDefault(); triggerDocsTerminal(); }
      if (key === 'p') { e.preventDefault(); setPricingOpen(prev => !prev); }
      if (e.key === 'Escape') { setConsoleOpen(false); setPricingOpen(false); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [triggerDocsTerminal]);

  // Nuke Sequence Effect
  useEffect(() => {
    if (isNuking) {
      const runNuke = async () => {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        setNukeStage(1); // Plane appears
        playPropellerSound(audioCtx, 6);
        await delay(3000); // Wait for plane to reach center

        setNukeStage(2); // Bomb drops
        playBombDropSound(audioCtx, 2.5);
        await delay(2500);

        setNukeStage(3); // Explosion white flash
        playExplosionSound(audioCtx);
        await delay(800);

        setNukeStage(4); // Fatal error screen
      };
      runNuke();
    }
  }, [isNuking]);

  const handleReadFeed = (idx) => {
    setExpandedFeed(expandedFeed === idx ? null : idx);
  };

  const DIRECTORY_FEED = isHacked
    ? [{ date: '1970.1.1', title: '[TOP SECRET] RUNTIME DEBUG NOTE', content: 'CLASSIFIED: Website easter eggs are simulated. Real Servus runs stay scoped, consent-gated, and proof-checked before completion.' }, ...BASE_DIRECTORY_FEED]
    : BASE_DIRECTORY_FEED;

  if (nukeStage === 4) {
    return (
      <div style={{ background: '#000', color: '#f00', height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'monospace', fontSize: '2rem', textAlign: 'center', whiteSpace: 'pre-wrap' }}>
        {`[ FATAL ERROR ]\n\n502 BAD GATEWAY\n\nSERVER HAS BEEN DESTROYED BY ROOT USER.`}
      </div>
    );
  }

  return (
    <div className={`app-wrapper ${isHacked ? 'hacked-mode' : ''}`}>
      <Toaster position="top-right" toastOptions={{ style: { fontSize: '0.875rem', borderRadius: '0.375rem' } }} />
      <audio ref={audioRef} src="/song.opus" style={{ display: 'none' }} onEnded={() => setIsPlaying(false)} />
      <div className="scanlines"></div>
      <div className="grid-bg"></div>

      {isNuking && nukeStage < 4 && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, pointerEvents: 'all', background: nukeStage === 3 ? '#fff' : 'transparent', transition: 'background 0.5s' }}>
          {nukeStage >= 1 && nukeStage < 3 && (
            <pre style={{ position: 'absolute', top: '10%', color: '#fff', fontSize: '10px', fontWeight: 'bold', animation: 'fly 6s linear forwards', whiteSpace: 'pre', lineHeight: '1' }}>
              {ASCII_PLANE}
            </pre>
          )}
          {nukeStage >= 2 && nukeStage < 3 && (
            <pre style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', color: '#fff', fontSize: '6px', fontWeight: 'bold', animation: 'drop 2.5s linear forwards', whiteSpace: 'pre', lineHeight: '1.2' }}>
              {ASCII_NUKE}
            </pre>
          )}
        </div>
      )}

      <nav className="nav-bar">
        <div className="nav-links">
          <a className="nav-item" href="https://github.com/TangoBeee/servus" target="_blank" rel="noopener noreferrer"><span className="nav-shortcut">[G]</span> GITHUB</a>
          <a className="nav-item" href="#" onClick={(e) => { e.preventDefault(); triggerDocsTerminal(); }}><span className="nav-shortcut">[D]</span> DOCS</a>
          <a className="nav-item" href="#" onClick={(e) => { e.preventDefault(); setPricingOpen(true); }}><span className="nav-shortcut">[P]</span> PRICING</a>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginLeft: 'auto' }}>
          <button onClick={() => { navigator.clipboard.writeText('npm install -g servusai'); toast.success('Copied: npm install -g servusai', { duration: 2000 }); }} style={{ background: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', color: '#22c55e', cursor: 'pointer', fontSize: '0.8rem', padding: '0.4rem 0.7rem', borderRadius: '0.375rem', transition: 'all 0.2s ease', display: 'flex', alignItems: 'center', gap: '0.4rem', fontFamily: 'var(--font-mono)', fontWeight: '500', whiteSpace: 'nowrap' }} onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34, 197, 94, 0.25)'; e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.6)'; e.currentTarget.style.boxShadow = '0 0 0.5rem rgba(34, 197, 94, 0.3)'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(34, 197, 94, 0.15)'; e.currentTarget.style.borderColor = 'rgba(34, 197, 94, 0.3)'; e.currentTarget.style.boxShadow = 'none'; }} title="Copy: npm install -g servusai">
            <span style={{ fontSize: '0.8rem' }}>📦</span>
            <code style={{ fontSize: '0.7rem', letterSpacing: '0.3px' }}>npm install -g servusai</code>
          </button>
          <span className="nav-item" onClick={() => setConsoleOpen(!consoleOpen)} style={{ cursor: 'pointer' }}>
            <span className="nav-shortcut">[C]</span> CONSOLE
          </span>
        </div>
      </nav>

      <main>
        <div className="hero-container">
          <div className="hero-left">
            <h1 className="hero-title" style={{ position: 'relative' }}>
              Welcome to Servus<span className="pixel-box">OS</span>
            </h1>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: isHacked ? '#f00' : 'var(--text-dim)', marginBottom: '1.5rem', background: isHacked ? 'rgba(255,0,0,0.1)' : 'rgba(255,255,255,0.05)', display: 'inline-flex', padding: '0.2rem 0.5rem', alignItems: 'center', gap: '0.5rem' }}>
              {isHacked ? '[ SYSTEM COMPROMISED ]' : <>[ <div style={{ display: 'inline-block', width: '0.5rem', height: '0.5rem', background: '#22c55e', borderRadius: '50%', boxShadow: '0 0 0.5rem #22c55e, inset 0 0 0.5rem rgba(34,197,94,0.5)', animation: 'pulse 2s infinite', margin: '0 0.25rem' }} /> IN ACTIVE DEVELOPMENT ]</>}
            </div>
            <p className="hero-desc">
              Local-first AI operator for coding, browser workflows, desktop files, data/docs, media, security analysis, and custom skills/plugins — with proof-backed completion.
            </p>
          </div>
          <div className="hero-right">
            <div className="badge-dev">V {__APP_VERSION__}</div>
            <div className="ascii-globe" style={{ color: isHacked ? '#f00' : 'var(--text-dim)' }}>
              {ASCII_GLOBE}
            </div>
          </div>
        </div>

        <div className="features-split">
          <div className="feature-col">
            <div className="slash-header"><span>/</span> AGENTIC LOOP</div>
            <div className="fig-box pulse-border">
              <span className="fig-label">[ FIG. 1 ]</span>
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-main)' }}>
                {ASCII_AGENTIC_LOOP}
              </pre>
            </div>
            <h2 className="feature-title">Autonomous Primitives</h2>
            <p className="hero-desc" style={{ fontSize: '1rem' }}>
              Every domain follows an evidence-backed loop: understand, discover, plan, act, verify, and finalize. Servus asks for input only when the runtime cannot safely continue.
            </p>
          </div>

          <div className="feature-col">
            <div className="slash-header"><span>/</span> LOCAL RUNTIME</div>
            <div className="fig-box">
              <span className="fig-label">[ FIG. 2 ]</span>
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-main)' }}>
                {ASCII_SHIELD}
              </pre>
            </div>
            <h2 className="feature-title">Secure Sandboxed Execution</h2>
            <p className="hero-desc" style={{ fontSize: '1rem' }}>
              Tool metadata, consent gates, safe path handling, session records, and proof bundles keep local automation observable and bounded.
            </p>
          </div>
        </div>

        {/* --- AGENT FLEET SECTION --- */}
        <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto', width: '100%', borderBottom: 'var(--border)' }}>
          <div className="slash-header" style={{ marginBottom: '2rem' }}><span>/</span> THE AGENT FLEET</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>

            <div className="fig-box pulse-border" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>[ &lt;/&gt; ]</div>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>CODING AGENT</h3>
              <p style={{ color: 'var(--text-dim)' }}>Reads repos, edits code, discovers verification commands, runs checks, and repairs failures with evidence before marking work done.</p>
            </div>

            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>[ OS ]</div>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>DESKTOP AGENT</h3>
              <p style={{ color: 'var(--text-dim)' }}>Handles local file and OS tasks with ranked search, exact path inspection, candidate selection, safe open/move/copy/trash, and verification.</p>
            </div>

            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>[ WWW ]</div>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>BROWSER AGENT</h3>
              <p style={{ color: 'var(--text-dim)' }}>Uses persistent Playwright sessions, hybrid snapshots, stable refs, screenshots, extraction, and explicit consent for irreversible web actions.</p>
            </div>

            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>[ MP4 ]</div>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>MEDIA AGENT</h3>
              <p style={{ color: 'var(--text-dim)' }}>Checks ffmpeg/ffprobe/yt-dlp readiness, inspects media, downloads, converts, trims, compresses, extracts audio, and generates thumbnails.</p>
            </div>

            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>[ CSV ]</div>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>DATA &amp; DOCS AGENT</h3>
              <p style={{ color: 'var(--text-dim)' }}>Reads PDF, DOCX, TXT, Markdown, CSV, TSV, JSON, XLS, and XLSX files; extracts tables; converts formats; and writes reports.</p>
            </div>

            <div className="fig-box pulse-border" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '1rem', color: 'var(--text-main)', fontFamily: 'var(--font-mono)', fontWeight: 800 }}>[ SEC ]</div>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>CYBER SECURITY AGENT</h3>
              <p style={{ color: 'var(--text-dim)' }}>Runs safe Offensive, Defensive, or Hybrid analysis for authorized targets: recon, static/dependency/config/log checks, TLS/headers, playbooks, and remediation reports.</p>
            </div>

          </div>
        </div>

        {/* --- SYSTEM CAPABILITIES SECTION --- */}
        <div style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto', width: '100%', borderBottom: 'var(--border)' }}>
          <div className="slash-header" style={{ marginBottom: '2rem' }}><span>/</span> SYSTEM CAPABILITIES</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>
            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>[ EVIDENCE CONTRACTS ]</h3>
              <p style={{ color: 'var(--text-dim)' }}>Run contracts define acceptance criteria, required evidence, risk, and repair attempts before a task can be accepted as complete.</p>
            </div>
            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>[ SESSION CONTINUITY ]</h3>
              <p style={{ color: 'var(--text-dim)' }}>Session records preserve domain, events, evidence, artifacts, cost, proof directories, browser state, and same-session continuations.</p>
            </div>
            <div className="fig-box pulse-border" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>[ SKILLS &amp; PLUGINS ]</h3>
              <p style={{ color: 'var(--text-dim)' }}>Create project or user skills and plugin manifests from prompts; load bundled, project, user, and plugin-provided extensions.</p>
            </div>
            <div className="fig-box" style={{ flexDirection: 'column', alignItems: 'flex-start', minHeight: 'auto', padding: '1.5rem' }}>
              <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-mono)', fontSize: '0.9rem' }}>[ TOOL REGISTRY ]</h3>
              <p style={{ color: 'var(--text-dim)' }}>Tools carry domain, risk, read-only/mutating, consent, timeout, and artifact metadata so high-risk actions stay gated.</p>
            </div>
          </div>
        </div>

        <div className="directory-feed">
          <div className="slash-header" style={{ color: isHacked ? '#f00' : 'inherit' }}><span>/</span> DIRECTORY FEED</div>

          {DIRECTORY_FEED.map((item, idx) => (
            <div key={idx}>
              <div className="tree-row" onClick={() => handleReadFeed(idx)} style={{ color: item.title.includes('SECRET') ? '#f00' : 'inherit', borderBottom: item.title.includes('SECRET') ? '1px dashed #f00' : '' }}>
                <span className="tree-icon">{expandedFeed === idx ? '[-]' : '[+]'}</span>
                <span className="tree-date" style={{ color: isHacked ? '#f00' : 'inherit' }}>{item.date}</span>
                <span className="tree-name">{item.title}</span>
                <span className="tree-action" style={{ color: isHacked ? '#f00' : 'var(--text-dim)' }}>{expandedFeed === idx ? '[ CLOSE ]' : '[ READ ]'}</span>
              </div>
              {expandedFeed === idx && (
                <div className="feed-content" style={{ borderColor: isHacked ? '#f00' : '' }}>
                  <pre style={{ fontFamily: 'inherit', whiteSpace: 'pre-wrap', color: item.title.includes('SECRET') ? '#f00' : 'inherit' }}>{item.content}</pre>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <footer style={{
          textAlign: 'center',
          padding: '4rem 2rem 2rem 2rem',
          fontFamily: 'var(--font-mono)',
          color: 'var(--text-dim)',
          fontSize: '0.85rem'
        }}>
          It's all AI.
        </footer>
      </main>

      {consoleOpen && (
        <Console
          onClose={() => setConsoleOpen(false)}
          history={history}
          setHistory={setHistory}
          commandHistory={commandHistory}
          setCommandHistory={setCommandHistory}
          isRoot={isRoot}
          setIsRoot={setIsRoot}
          setIsHacked={setIsHacked}
          setIsNuking={setIsNuking}
          audioRef={audioRef}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
          musicVolume={musicVolume}
          setMusicVolume={setMusicVolume}
        />
      )}

      {pricingOpen && <PricingModal onClose={() => setPricingOpen(false)} triggerContact={triggerContactTerminal} />}
    </div>
  )
}

export default App
