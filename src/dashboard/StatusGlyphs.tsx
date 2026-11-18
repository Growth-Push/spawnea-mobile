import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * Canonical session-status glyphs, matching Spawnea Desktop's StatusBadge.tsx:
 * starting → Loader2, working → Radio, needs_input → MessageSquare,
 * done → CheckCircle2, error → AlertCircle, disconnected → Unplug, idle → Clock.
 * Geometries are copied from lucide-react@1.70.0 (ISC), see THIRD_PARTY_NOTICES.md.
 * Unknown statuses get a distinct, explicit "question mark" fallback.
 */
export type StatusGlyphKind =
  | 'starting'
  | 'working'
  | 'needs_input'
  | 'done'
  | 'error'
  | 'disconnected'
  | 'idle'
  | 'unknown';

export function statusGlyphKind(status: string): StatusGlyphKind {
  switch (status) {
    case 'starting':
    case 'working':
    case 'needs_input':
    case 'done':
    case 'error':
    case 'disconnected':
    case 'idle':
      return status;
    default:
      return 'unknown';
  }
}

/** lucide icon name each glyph was copied from (documentation + test anchor). */
export const STATUS_GLYPH_SOURCES: Record<StatusGlyphKind, string> = {
  starting: 'loader-circle (Loader2)',
  working: 'radio (Radio)',
  needs_input: 'message-square (MessageSquare)',
  done: 'circle-check (CheckCircle2)',
  error: 'circle-exclamation-point (AlertCircle)',
  disconnected: 'unplug (Unplug)',
  idle: 'clock (Clock)',
  unknown: 'circle-question-mark (fallback)',
};

function glyphShapes(kind: StatusGlyphKind): React.JSX.Element {
  switch (kind) {
    case 'starting':
      return <Path d="M21 12a9 9 0 1 1-6.219-8.56" />;
    case 'working':
      return (
        <>
          <Path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
          <Path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
          <Path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
          <Path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
          <Circle cx="12" cy="12" r="2" />
        </>
      );
    case 'needs_input':
      return (
        <Path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" />
      );
    case 'done':
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Path d="m16 9-5.5 5.5L8 12" />
        </>
      );
    case 'error':
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Path d="M12 8v4" />
          <Path d="M12 16h.01" />
        </>
      );
    case 'disconnected':
      return (
        <>
          <Path d="m19 5 3-3" />
          <Path d="m2 22 3-3" />
          <Path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
          <Path d="M7.5 13.5 10 11" />
          <Path d="M10.5 16.5 13 14" />
          <Path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
        </>
      );
    case 'idle':
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Path d="M12 6v6l4 2" />
        </>
      );
    case 'unknown':
    default:
      return (
        <>
          <Circle cx="12" cy="12" r="10" />
          <Path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <Path d="M12 17h.01" />
        </>
      );
  }
}

/** Decorative glyph: the chip's own text and accessibility label carry the meaning. */
export function StatusGlyph({
  status,
  color,
  size = 12,
}: {
  status: string;
  color: string;
  size?: number;
}): React.JSX.Element {
  const kind = statusGlyphKind(status);
  return (
    <Svg
      testID={`status-glyph-${kind}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden>
      {glyphShapes(kind)}
    </Svg>
  );
}
