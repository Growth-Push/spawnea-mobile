export type ProviderType =
  | 'hermes'
  | 'antigravity'
  | 'claude'
  | 'codex'
  | 'deepseek'
  | 'kimi'
  | 'ollama'
  | 'gemini'
  | 'copilot'
  | 'cursor'
  | 'mistral'
  | 'qwen'
  | 'llama'
  | 'grok'
  | 'none'
  | 'generic';

export type OsType =
  | 'arch'
  | 'ubuntu'
  | 'debian'
  | 'raspberry'
  | 'fedora'
  | 'redhat'
  | 'centos'
  | 'rocky'
  | 'almalinux'
  | 'alpine'
  | 'nixos'
  | 'opensuse'
  | 'gentoo'
  | 'void'
  | 'kali'
  | 'macos'
  | 'windows'
  | 'freebsd'
  | 'linux'
  | 'generic';

/** Lowercases and splits on any non-alphanumeric run: "build-machine-01" -> [build, machine, 01]. */
function tokenize(value?: string): string[] {
  return (value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when `seq` appears as adjacent whole tokens ("red hat", "deep-seek", "x.ai"). */
function hasSequence(tokens: string[], seq: string[]): boolean {
  for (let i = 0; i + seq.length <= tokens.length; i += 1) {
    if (seq.every((part, offset) => tokens[i + offset] === part)) {
      return true;
    }
  }
  return false;
}

function hasAnyToken(tokens: string[], words: string[]): boolean {
  return words.some(word => tokens.includes(word));
}

/**
 * Executable name of a command line: first word, directory and `.exe`/`.sh`/`.cmd`
 * suffix stripped. Arguments and parent directories are never matched, so
 * "/home/me/github/run.sh" yields "run" and "metabase --serve" yields "metabase".
 */
export function getExecutableBasename(command?: string): string {
  const first = (command || '').trim().split(/\s+/)[0] || '';
  const unquoted = first.replace(/^["']+|["']+$/g, '');
  const base = unquoted.split(/[\\/]/).pop() || '';
  return base.replace(/\.(exe|sh|cmd|bat)$/i, '');
}

function isTerminalValue(value?: string): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === 'none' || normalized === 'terminal';
}

/**
 * Detects the agent/harness provider family. Mirrors Spawnea Desktop's AgentIcon.tsx
 * priorities, but matches whole tokens of the harness id/name and the executable
 * basename instead of raw substrings of the full command line. Falls back to
 * `'generic'` when unrecognized.
 */
export function detectProviderType(
  harness?: string,
  agentName?: string,
  command?: string,
): ProviderType {
  if (isTerminalValue(harness) || isTerminalValue(agentName)) {
    return 'none';
  }

  const normalizedHarness = (harness || '').trim().toLowerCase();
  if (normalizedHarness === 'hermes') {
    return 'hermes';
  }
  if (normalizedHarness === 'agy' || normalizedHarness === 'antigravity') {
    return 'antigravity';
  }
  if (normalizedHarness === 'claude' || normalizedHarness === 'anthropic') {
    return 'claude';
  }
  if (normalizedHarness === 'codex' || normalizedHarness === 'openai') {
    return 'codex';
  }
  if (normalizedHarness === 'grok' || normalizedHarness === 'xai') {
    return 'grok';
  }
  if (normalizedHarness === 'deepseek') {
    return 'deepseek';
  }
  if (normalizedHarness === 'kimi') {
    return 'kimi';
  }
  if (normalizedHarness === 'ollama') {
    return 'ollama';
  }
  if (normalizedHarness === 'gemini') {
    return 'gemini';
  }
  if (normalizedHarness === 'copilot') {
    return 'copilot';
  }
  if (normalizedHarness === 'cursor') {
    return 'cursor';
  }
  if (normalizedHarness === 'mistral') {
    return 'mistral';
  }
  if (normalizedHarness === 'qwen') {
    return 'qwen';
  }
  if (normalizedHarness === 'llama') {
    return 'llama';
  }

  const tokens = [
    ...tokenize(harness),
    ...tokenize(agentName),
    ...tokenize(getExecutableBasename(command)),
  ];

  if (hasAnyToken(tokens, ['hermes'])) {
    return 'hermes';
  }
  if (hasAnyToken(tokens, ['agy', 'antigravity'])) {
    return 'antigravity';
  }
  if (hasAnyToken(tokens, ['claude', 'anthropic'])) {
    return 'claude';
  }
  if (hasAnyToken(tokens, ['codex', 'openai', 'chatgpt', 'gpt'])) {
    return 'codex';
  }
  if (hasAnyToken(tokens, ['grok', 'xai']) || hasSequence(tokens, ['x', 'ai'])) {
    return 'grok';
  }
  if (hasAnyToken(tokens, ['deepseek']) || hasSequence(tokens, ['deep', 'seek'])) {
    return 'deepseek';
  }
  if (hasAnyToken(tokens, ['kimi', 'kimmy', 'moonshot'])) {
    return 'kimi';
  }
  if (hasAnyToken(tokens, ['ollama'])) {
    return 'ollama';
  }
  if (hasAnyToken(tokens, ['gemini', 'google'])) {
    return 'gemini';
  }
  if (hasAnyToken(tokens, ['copilot', 'github'])) {
    return 'copilot';
  }
  if (hasAnyToken(tokens, ['cursor'])) {
    return 'cursor';
  }
  if (hasAnyToken(tokens, ['mistral', 'codestral', 'devin'])) {
    return 'mistral';
  }
  if (hasAnyToken(tokens, ['qwen', 'alibaba'])) {
    return 'qwen';
  }
  if (hasAnyToken(tokens, ['llama', 'meta'])) {
    return 'llama';
  }

  return 'generic';
}

export function getProviderDisplayName(type: ProviderType): string {
  switch (type) {
    case 'hermes':
      return 'Hermes';
    case 'antigravity':
      return 'Antigravity';
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'grok':
      return 'Grok (xAI)';
    case 'deepseek':
      return 'DeepSeek';
    case 'kimi':
      return 'Kimi';
    case 'ollama':
      return 'Ollama';
    case 'gemini':
      return 'Gemini';
    case 'copilot':
      return 'GitHub Copilot';
    case 'cursor':
      return 'Cursor';
    case 'mistral':
      return 'Mistral';
    case 'qwen':
      return 'Qwen';
    case 'llama':
      return 'Llama';
    case 'none':
      return 'Terminal';
    case 'generic':
    default:
      return 'Agent Harness';
  }
}

/**
 * Detects the host operating system from its name using Spawnea Desktop's OsIcon.tsx
 * keyword rules, matched as whole tokens ("Local · Arch" is Arch; "search", "archive",
 * "machine" or "unix" are not). Returns `'generic'` when no OS keyword is present so
 * callers fall back to the generic host glyph.
 */
export function detectOsType(nameOrOsString?: string): OsType {
  if (!nameOrOsString) {
    return 'generic';
  }
  const tokens = tokenize(nameOrOsString);
  const any = (words: string[]) => hasAnyToken(tokens, words);

  if (any(['arch', 'archlinux', 'endeavour', 'endeavouros', 'manjaro', 'garuda', 'artix'])) {
    return 'arch';
  }
  if (
    any(['ubuntu', 'popos', 'mint', 'elementary', 'zorin']) ||
    hasSequence(tokens, ['pop', 'os'])
  ) {
    return 'ubuntu';
  }
  if (any(['raspbian', 'raspberry', 'raspberrypi', 'rpi'])) {
    return 'raspberry';
  }
  if (any(['debian'])) {
    return 'debian';
  }
  if (any(['fedora', 'nobara', 'silverblue'])) {
    return 'fedora';
  }
  if (any(['rhel', 'redhat']) || hasSequence(tokens, ['red', 'hat'])) {
    return 'redhat';
  }
  if (any(['centos'])) {
    return 'centos';
  }
  if (any(['rocky', 'rockylinux'])) {
    return 'rocky';
  }
  if (any(['alma', 'almalinux'])) {
    return 'almalinux';
  }
  if (any(['alpine'])) {
    return 'alpine';
  }
  if (any(['nixos', 'nix'])) {
    return 'nixos';
  }
  if (any(['suse', 'opensuse', 'tumbleweed', 'leap'])) {
    return 'opensuse';
  }
  if (any(['gentoo'])) {
    return 'gentoo';
  }
  if (any(['void', 'voidlinux'])) {
    return 'void';
  }
  if (any(['kali', 'kalilinux'])) {
    return 'kali';
  }
  if (any(['darwin', 'mac', 'macos', 'macbook', 'apple', 'osx'])) {
    return 'macos';
  }
  if (any(['windows', 'wsl', 'win32', 'msys', 'cygwin'])) {
    return 'windows';
  }
  if (any(['freebsd', 'openbsd', 'netbsd', 'dragonfly', 'bsd'])) {
    return 'freebsd';
  }
  if (any(['linux'])) {
    return 'linux';
  }

  return 'generic';
}

export function getOsDisplayName(type: OsType): string {
  switch (type) {
    case 'arch':
      return 'Arch Linux';
    case 'ubuntu':
      return 'Ubuntu';
    case 'debian':
      return 'Debian';
    case 'raspberry':
      return 'Raspberry Pi OS';
    case 'fedora':
      return 'Fedora';
    case 'redhat':
      return 'Red Hat Enterprise Linux';
    case 'centos':
      return 'CentOS';
    case 'rocky':
      return 'Rocky Linux';
    case 'almalinux':
      return 'AlmaLinux';
    case 'alpine':
      return 'Alpine Linux';
    case 'nixos':
      return 'NixOS';
    case 'opensuse':
      return 'openSUSE';
    case 'gentoo':
      return 'Gentoo';
    case 'void':
      return 'Void Linux';
    case 'kali':
      return 'Kali Linux';
    case 'macos':
      return 'macOS';
    case 'windows':
      return 'Windows';
    case 'freebsd':
      return 'FreeBSD';
    case 'linux':
      return 'Linux';
    case 'generic':
    default:
      return 'Host';
  }
}
