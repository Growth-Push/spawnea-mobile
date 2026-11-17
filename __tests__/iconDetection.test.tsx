import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SpawneaApiClient } from '../src/api/client';
import {
  GROWTH_PUSH_MIN_OUTER_SIZE,
  GrowthPushMark,
  GrowthPushSignature,
  HarnessIcon,
  HOST_BRAND_COLORS,
  HostIcon,
  PROVIDER_BRAND_COLORS,
  SpawneaMarkIcon,
} from '../src/dashboard/DashboardIcons';
import { LOBE_HERMES_AGENT_PATHS, SIMPLE_ICONS_HOST_PATHS } from '../src/dashboard/iconPaths';
import {
  contrastRatio,
  ICON_DARK_SURFACES,
  MIN_ICON_CONTRAST,
  minContrastOnDark,
  resolveIconColor,
} from '../src/dashboard/iconColors';
import {
  detectOsType,
  getExecutableBasename,
  detectProviderType,
  getOsDisplayName,
  getProviderDisplayName,
} from '../src/dashboard/iconDetection';
import { SettingsScreen } from '../src/screens/SettingsScreen';

function renderSync(element: React.ReactElement): ReactTestRenderer.ReactTestRenderer {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(element);
  });
  return renderer;
}

describe('iconDetection', () => {
  test('detectProviderType matches desktop AgentIcon rules and falls back to generic', () => {
    expect(detectProviderType('claude', 'Claude Code', 'claude')).toBe('claude');
    expect(detectProviderType('codex', 'Codex', 'codex')).toBe('codex');
    expect(detectProviderType('agy', 'Antigravity', 'agy')).toBe('antigravity');
    expect(detectProviderType('grok', 'Grok', 'grok')).toBe('grok');
    expect(detectProviderType('hermes', 'Hermes', 'hermes')).toBe('hermes');
    expect(detectProviderType('xai', 'Custom', 'run')).toBe('grok');
    expect(detectProviderType('anthropic', '', '')).toBe('claude');
    expect(detectProviderType('openai', '', '')).toBe('codex');
    expect(detectProviderType('', 'My GPT Agent', 'cli')).toBe('codex');
    expect(detectProviderType('deepseek')).toBe('deepseek');
    expect(detectProviderType('kimi')).toBe('kimi');
    expect(detectProviderType('ollama')).toBe('ollama');
    expect(detectProviderType('gemini')).toBe('gemini');
    expect(detectProviderType('copilot')).toBe('copilot');
    expect(detectProviderType('cursor')).toBe('cursor');
    expect(detectProviderType('mistral')).toBe('mistral');
    expect(detectProviderType('qwen')).toBe('qwen');
    expect(detectProviderType('llama')).toBe('llama');

    // Interactive shells & unknowns
    expect(detectProviderType('none', 'Shell', 'zsh')).toBe('none');
    expect(detectProviderType('terminal', 'Shell', 'bash')).toBe('none');
    expect(detectProviderType('custom', 'Terminal', 'zsh')).toBe('none');
    expect(detectProviderType('zsh', 'Shell', 'zsh')).toBe('generic');
    expect(detectProviderType('unknown-harness', 'Custom Agent', 'my-bin')).toBe(
      'generic',
    );
    expect(detectProviderType(undefined, undefined, undefined)).toBe('generic');
  });

  test('detectOsType matches desktop OsIcon rules and falls back to generic when unknown', () => {
    expect(detectOsType('Local · Arch')).toBe('arch');
    expect(detectOsType('manjaro-workstation')).toBe('arch');
    expect(detectOsType('Ubuntu 24.04')).toBe('ubuntu');
    expect(detectOsType('Debian Bookworm')).toBe('debian');
    expect(detectOsType('rpi-cluster-01')).toBe('raspberry');
    expect(detectOsType('fedora-dev')).toBe('fedora');
    expect(detectOsType('rhel-9')).toBe('redhat');
    expect(detectOsType('centos-stream')).toBe('centos');
    expect(detectOsType('rocky-9')).toBe('rocky');
    expect(detectOsType('almalinux-9')).toBe('almalinux');
    expect(detectOsType('alpine-container')).toBe('alpine');
    expect(detectOsType('nixos-server')).toBe('nixos');
    expect(detectOsType('opensuse-tumbleweed')).toBe('opensuse');
    expect(detectOsType('gentoo-stage3')).toBe('gentoo');
    expect(detectOsType('void-box')).toBe('void');
    expect(detectOsType('kali-lab')).toBe('kali');
    expect(detectOsType('MacBook-Pro.local')).toBe('macos');
    expect(detectOsType('windows-wsl-node')).toBe('windows');
    expect(detectOsType('freebsd-jail')).toBe('freebsd');
    expect(detectOsType('prod-linux-01')).toBe('linux');

    // Unknown host names fall back to generic glyph
    expect(detectOsType('')).toBe('generic');
    expect(detectOsType(undefined)).toBe('generic');
    expect(detectOsType('Host One')).toBe('generic');
    expect(detectOsType('build-box-02')).toBe('generic');
  });

  test('detectOsType matches whole tokens, never loose substrings', () => {
    expect(detectOsType('Local · Arch')).toBe('arch');
    expect(detectOsType('arch-box')).toBe('arch');
    for (const host of [
      'search',
      'search-indexer',
      'archive',
      'archive-box',
      'research-01',
      'machine',
      'build-machine-01',
      'unix',
      'unix-box',
      'community',
      'minting-service',
      'voidless',
      'rpicker',
    ]) {
      expect([host, detectOsType(host)]).toEqual([host, 'generic']);
    }
    expect(detectOsType('pop!_os')).toBe('ubuntu');
    expect(detectOsType('Red Hat Enterprise')).toBe('redhat');
    expect(detectOsType('Mac mini')).toBe('macos');
  });

  test('detectProviderType uses id/name tokens and the executable basename only', () => {
    // Paths and arguments in the command are never matched.
    expect(detectProviderType('custom', 'Runner', '/home/me/github/x')).toBe('generic');
    expect(detectProviderType('custom', 'Runner', '/opt/metabase/run.sh')).toBe('generic');
    expect(detectProviderType('custom', 'Runner', 'metabase --serve')).toBe('generic');
    expect(detectProviderType('custom', 'Runner', 'node /srv/google/agy.js')).toBe('generic');
    expect(detectProviderType('custom', 'Runner', 'run --model gpt-5')).toBe('generic');
    // The executable itself still counts.
    expect(detectProviderType('custom', 'Runner', '/usr/local/bin/claude --resume')).toBe('claude');
    expect(detectProviderType('custom', 'Runner', 'C:\\tools\\codex.exe')).toBe('codex');
    expect(detectProviderType('custom', 'Runner', '"agy"')).toBe('antigravity');
    // Names are tokenised too: "metabase" is not Llama, "GitHub Copilot" is Copilot.
    expect(detectProviderType('custom', 'Metabase Agent', 'run')).toBe('generic');
    expect(detectProviderType('custom', 'Meta Llama Runner', 'run')).toBe('llama');
    expect(detectProviderType('custom', 'GitHub Copilot', 'run')).toBe('copilot');
    expect(getExecutableBasename('/home/me/github/x')).toBe('x');
    expect(getExecutableBasename('  /a/b/tool.sh --flag ')).toBe('tool');
    expect(getExecutableBasename(undefined)).toBe('');
    // Real catalog entries are unchanged.
    expect(detectProviderType('claude', 'Claude (Local · Arch)', 'claude')).toBe('claude');
    expect(detectProviderType('codex', 'Codex (Local · Arch)', 'codex')).toBe('codex');
    expect(detectProviderType('agy', 'Antigravity (Local · Arch)', 'agy')).toBe('antigravity');
    expect(detectProviderType('grok', 'Grok (Local · Arch)', 'grok')).toBe('grok');
    expect(detectProviderType('hermes', 'Hermes (Local · Arch)', 'hermes')).toBe('hermes');
    expect(detectProviderType('zsh', 'Shell', 'zsh')).toBe('generic');
  });

  test('terminal check is normalized (trim + lowercase)', () => {
    for (const value of ['none', 'None', 'NONE', ' terminal ', 'Terminal', '\tTERMINAL\n']) {
      expect([value, detectProviderType(value, 'Shell', 'claude')]).toEqual([value, 'none']);
      expect([value, detectProviderType('custom', value, 'codex')]).toEqual([value, 'none']);
    }
    expect(detectProviderType('terminals', 'Shell', 'zsh')).toBe('generic');
  });

  test('display name helpers return readable labels', () => {
    expect(getProviderDisplayName('grok')).toBe('Grok (xAI)');
    expect(getProviderDisplayName('generic')).toBe('Agent Harness');
    expect(getOsDisplayName('arch')).toBe('Arch Linux');
    expect(getOsDisplayName('generic')).toBe('Host');
  });
});

describe('DashboardIcons rendering & fallback', () => {
  test('SpawneaMarkIcon renders vectorized Spawnea brand colors and stays decorative', () => {
    const renderer = renderSync(<SpawneaMarkIcon size={20} />);
    const tree = renderer.toJSON() as ReactTestRenderer.ReactTestRendererJSON;
    expect(tree.props.testID).toBe('spawnea-mark-icon');
    expect(tree.props.importantForAccessibility).toBe('no-hide-descendants');

    const serialized = JSON.stringify(tree);
    expect(serialized).toContain('#009ebb');
    expect(serialized).toContain('#6a5bfd');
    expect(serialized).toContain('#c3e71c');
  });

  test('GrowthPushMark size is the real outer box and respects the 32 px symbol minimum', () => {
    const rendered = renderSync(<GrowthPushMark size={64} />);
    const wrap = rendered.root.findByProps({ testID: 'growth-push-mark' });
    const wrapStyle = StyleSheet.flatten(wrap.props.style);
    expect(wrapStyle.width).toBe(64);
    expect(wrapStyle.height).toBe(64);
    const svg = rendered.root.findByType(
      'RNSVGSvg' as unknown as React.ComponentType<any>,
    );
    expect(svg.props.width).toBeGreaterThanOrEqual(32);
    // Clear space on each side is at least 17% of the symbol width.
    expect((64 - svg.props.width) / 2).toBeGreaterThanOrEqual(svg.props.width * 0.17);

    const min = renderSync(<GrowthPushMark size={GROWTH_PUSH_MIN_OUTER_SIZE} />);
    expect(
      StyleSheet.flatten(
        min.root.findByProps({ testID: 'growth-push-mark' }).props.style,
      ).width,
    ).toBe(GROWTH_PUSH_MIN_OUTER_SIZE);
    expect(
      min.root.findByType('RNSVGSvg' as unknown as React.ComponentType<any>).props.width,
    ).toBe(32);

    // Asking for 16 never yields a larger box: below the brand minimum nothing renders.
    expect(renderSync(<GrowthPushMark size={16} />).toJSON()).toBeNull();
    expect(renderSync(<GrowthPushMark size={43} />).toJSON()).toBeNull();
  });

  test('GrowthPushSignature shows the mark and the visible text', () => {
    const sig = renderSync(<GrowthPushSignature />);
    const markWrap = sig.root.findByProps({ testID: 'growth-push-mark' });
    expect(markWrap.props.importantForAccessibility).toBe('no-hide-descendants');
    const texts = sig.root.findAllByType(Text).map(n => n.props.children);
    expect(JSON.stringify(texts)).toContain('Growth Push');
  });

  test('HarnessIcon renders known provider vectors and falls back to generic/terminal glyphs', () => {
    const claude = renderSync(
      <HarnessIcon
        harnessId="claude"
        harnessName="Claude Code"
        harnessCommand="claude"
        size={12}
      />,
    );
    const claudeTree = claude.toJSON() as ReactTestRenderer.ReactTestRendererJSON;
    expect(claudeTree.props.testID).toBe('provider-icon-claude');
    expect(claudeTree.props.importantForAccessibility).toBe('no-hide-descendants');

    const grok = renderSync(
      <HarnessIcon
        harnessId="grok"
        harnessName="Grok"
        harnessCommand="grok"
        size={12}
      />,
    );
    const grokJson = JSON.stringify(grok.toJSON());
    expect(grokJson).toContain('provider-icon-grok');
    expect(grokJson).toContain('#050505');
    expect(grokJson).toContain('#FCFCFC');

    const zsh = renderSync(
      <HarnessIcon
        harnessId="zsh"
        harnessName="Shell"
        harnessCommand="zsh"
        size={12}
      />,
    );
    expect(
      (zsh.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props
        .importantForAccessibility,
    ).toBe('no-hide-descendants');
    expect(
      (zsh.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props.testID,
    ).toBe('provider-icon-generic');

    const none = renderSync(
      <HarnessIcon
        harnessId="none"
        harnessName="Terminal"
        harnessCommand="zsh"
        size={12}
      />,
    );
    expect(
      (none.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props.testID,
    ).toBe('provider-icon-terminal');
    expect(
      (none.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props
        .importantForAccessibility,
    ).toBe('no-hide-descendants');

    const unknown = renderSync(
      <HarnessIcon
        harnessId="acme-agent"
        harnessName="Acme"
        harnessCommand="acme"
        size={12}
      />,
    );
    expect(
      (unknown.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props
        .testID,
    ).toBe('provider-icon-generic');
    expect(
      (unknown.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props
        .importantForAccessibility,
    ).toBe('no-hide-descendants');
  });

  test('HostIcon renders the Simple Icons mark for the 15 supported OSes and the generic glyph otherwise', () => {
    const cases: Array<[string, string, keyof typeof SIMPLE_ICONS_HOST_PATHS]> = [
      ['Local · Arch', 'arch', 'archlinux'],
      ['ubuntu-24', 'ubuntu', 'ubuntu'],
      ['debian-12', 'debian', 'debian'],
      ['rpi-01', 'raspberry', 'raspberrypi'],
      ['fedora-dev', 'fedora', 'fedora'],
      ['rhel-9', 'redhat', 'redhat'],
      ['centos-stream', 'centos', 'centos'],
      ['rocky-9', 'rocky', 'rockylinux'],
      ['almalinux-9', 'almalinux', 'almalinux'],
      ['alpine-edge', 'alpine', 'alpinelinux'],
      ['nixos-server', 'nixos', 'nixos'],
      ['opensuse-leap', 'opensuse', 'opensuse'],
      ['MacBook-Pro.local', 'macos', 'apple'],
      ['prod-linux-01', 'linux', 'linux'],
      ['freebsd-jail', 'freebsd', 'freebsd'],
    ];
    for (const [hostName, osType, slug] of cases) {
      const rendered = renderSync(<HostIcon hostName={hostName} size={12} color="#8b949e" />);
      const tree = rendered.toJSON() as ReactTestRenderer.ReactTestRendererJSON;
      expect([hostName, tree.props.testID]).toEqual([hostName, `host-icon-${osType}`]);
      expect(tree.props.importantForAccessibility).toBe('no-hide-descendants');
      const path = rendered.root.findByType(
        'RNSVGPath' as unknown as React.ComponentType<any>,
      );
      expect(path.props.d).toBe(SIMPLE_ICONS_HOST_PATHS[slug].d);
      const expectedFill = minContrastOnDark(HOST_BRAND_COLORS[slug]) >= MIN_ICON_CONTRAST
        ? HOST_BRAND_COLORS[slug]
        : '#8b949e';
      expect([hostName, path.props.fill]).toEqual([hostName, expectedFill]);
    }

    // Black marks (Apple, AlmaLinux) cannot reach 3:1 on dark: monochrome prop color.
    const apple = renderSync(<HostIcon hostName="MacBook-Pro.local" color="#8b949e" />);
    expect(
      apple.root.findByType('RNSVGPath' as unknown as React.ComponentType<any>).props.fill,
    ).toBe('#8b949e');

    // Windows, Gentoo, Void, Kali, unknown and missing names stay generic.
    for (const hostName of ['windows-wsl-node', 'gentoo-host', 'void-box', 'kali-lab', 'build-machine-01', 'Host One', undefined]) {
      const tree = renderSync(
        <HostIcon hostName={hostName} size={12} />,
      ).toJSON() as ReactTestRenderer.ReactTestRendererJSON;
      expect([hostName, tree.props.testID]).toEqual([hostName, 'host-icon-generic']);
      expect(tree.props.importantForAccessibility).toBe('no-hide-descendants');
    }
  });

  test('every fixed harness color reaches 3:1 on every dark surface or falls back to the prop color', () => {
    const fixedColors: Array<[string, string, string]> = [
      ...Object.entries(PROVIDER_BRAND_COLORS).map(
        ([name, hex]): [string, string, string] => [name, hex, '#a78bfa'],
      ),
      ...Object.entries(HOST_BRAND_COLORS).map(
        ([name, hex]): [string, string, string] => [name, hex, '#8b949e'],
      ),
    ];
    expect(fixedColors.length).toBe(
      Object.keys(PROVIDER_BRAND_COLORS).length + Object.keys(HOST_BRAND_COLORS).length,
    );
    for (const [provider, brand, mono] of fixedColors) {
      const ratios = ICON_DARK_SURFACES.map(surface => contrastRatio(brand, surface));
      const worst = Math.min(...ratios);
      expect(minContrastOnDark(brand)).toBeCloseTo(worst, 10);
      const resolved = resolveIconColor(brand, mono);
      if (worst >= MIN_ICON_CONTRAST) {
        expect([provider, resolved]).toEqual([provider, brand]);
      } else {
        expect([provider, resolved]).toEqual([provider, mono]);
      }
      // Whatever is finally drawn is >= 3:1 on all surfaces.
      expect(minContrastOnDark(resolved)).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
    }
    // Sanity: the prop colors used by the screens pass too.
    expect(minContrastOnDark('#a78bfa')).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
    expect(minContrastOnDark('#8b949e')).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
  });

  test('low-contrast harness icons render with the monochrome prop color, others keep brand fill', () => {
    const qwen = JSON.stringify(
      renderSync(
        <HarnessIcon harnessId="qwen" harnessName="Qwen" harnessCommand="qwen" color="#a78bfa" />,
      ).toJSON(),
    );
    expect(minContrastOnDark(PROVIDER_BRAND_COLORS.qwen)).toBeLessThan(MIN_ICON_CONTRAST);
    expect(qwen).toContain('#a78bfa');
    expect(qwen).not.toContain(PROVIDER_BRAND_COLORS.qwen);

    const llama = JSON.stringify(
      renderSync(
        <HarnessIcon harnessId="llama" harnessName="Llama" harnessCommand="llama" color="#a78bfa" />,
      ).toJSON(),
    );
    expect(llama).not.toContain(PROVIDER_BRAND_COLORS.llama);

    const claude = JSON.stringify(
      renderSync(
        <HarnessIcon harnessId="claude" harnessName="Claude" harnessCommand="claude" color="#a78bfa" />,
      ).toJSON(),
    );
    expect(claude).toContain(PROVIDER_BRAND_COLORS.claude);
  });

  test('Hermes renders the Lobe Icons hermesagent mark with verified contrast', () => {
    const rendered = renderSync(
      <HarnessIcon harnessId="hermes" harnessName="Hermes" harnessCommand="hermes" color="#a78bfa" />,
    );
    const tree = rendered.toJSON() as ReactTestRenderer.ReactTestRendererJSON;
    expect(tree.props.testID).toBe('provider-icon-hermes');
    expect(tree.props.importantForAccessibility).toBe('no-hide-descendants');
    const paths = rendered.root.findAllByType(
      'RNSVGPath' as unknown as React.ComponentType<any>,
    );
    expect(paths.map(p => p.props.d)).toEqual([...LOBE_HERMES_AGENT_PATHS]);
    expect(minContrastOnDark(PROVIDER_BRAND_COLORS.hermes)).toBeGreaterThanOrEqual(
      MIN_ICON_CONTRAST,
    );
    expect(paths.every(p => p.props.fill === PROVIDER_BRAND_COLORS.hermes)).toBe(true);
  });

  test('SettingsScreen uses dark palette tokens and displays Growth Push footer', async () => {
    const client = new SpawneaApiClient({
      transport: { request: jest.fn() },
      allowDebugLoopback: false,
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SettingsScreen apiClient={client} allowDebugLoopback={false} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const scroll = renderer.root.findByProps({ testID: 'settings-screen' });
    expect(scroll.props.style.backgroundColor).toBe('#0d1117');
    const urlInput = renderer.root.findByProps({ testID: 'server-url-input' });
    expect(urlInput.props.style.backgroundColor).toBe('#161b22');
    expect(urlInput.props.style.color).toBe('#f0f6fc');

    const footer = renderer.root.findByProps({
      testID: 'settings-growth-push-footer',
    });
    expect(footer).toBeTruthy();
    expect(
      renderer.root.findByProps({ testID: 'growth-push-signature' }),
    ).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain('Growth Push');
  });
});
