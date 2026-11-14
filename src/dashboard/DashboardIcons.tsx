import React from 'react';
import { StyleSheet, View } from 'react-native';

interface IconProps {
  color?: string;
  size?: number;
}

export function SpawneaMarkIcon({
  color = '#a78bfa',
  size = 20,
}: IconProps): React.JSX.Element {
  const half = Math.round(size * 0.52);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.box, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.markTileTop,
          {
            width: half,
            height: half,
            borderColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.markTileBottom,
          {
            width: half,
            height: half,
            borderColor: color,
          },
        ]}
      />
    </View>
  );
}

export function HostIcon({
  color = '#8b949e',
  size = 12,
}: IconProps): React.JSX.Element {
  const boxW = size;
  const boxH = Math.max(7, Math.round(size * 0.68));
  const standW = Math.max(6, Math.round(size * 0.55));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.hostWrap, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.hostScreen,
          { width: boxW, height: boxH, borderColor: color },
        ]}
      />
      <View
        style={[iconStyles.hostStand, { width: standW, backgroundColor: color }]}
      />
    </View>
  );
}

export function HarnessIcon({
  color = '#a78bfa',
  size = 12,
}: IconProps): React.JSX.Element {
  const promptSize = Math.max(4, Math.round(size * 0.36));
  const barW = Math.max(3, Math.round(size * 0.28));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        iconStyles.harnessBox,
        { width: size, height: size, borderColor: color },
      ]}>
      <View
        style={[
          iconStyles.harnessChevron,
          {
            width: promptSize,
            height: promptSize,
            borderTopColor: color,
            borderRightColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.harnessUnderscore,
          { width: barW, backgroundColor: color },
        ]}
      />
    </View>
  );
}

export function BranchIcon({
  color = '#8b949e',
  size = 12,
}: IconProps): React.JSX.Element {
  const dot = Math.max(3, Math.round(size * 0.28));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.box, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.branchStem,
          { left: Math.floor(dot / 2), backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.branchDot,
          iconStyles.branchDotTopLeft,
          { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.branchDot,
          iconStyles.branchDotBottomLeft,
          { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.branchDot,
          iconStyles.branchDotRight,
          {
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            top: Math.round(size * 0.22),
            backgroundColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.branchArm,
          {
            width: Math.max(5, Math.round(size * 0.55)),
            height: Math.max(4, Math.round(size * 0.38)),
            bottom: Math.round(size * 0.22),
            left: Math.floor(dot / 2),
            borderColor: color,
          },
        ]}
      />
    </View>
  );
}

export function ChildrenIcon({
  color = '#c4b5fd',
  size = 12,
}: IconProps): React.JSX.Element {
  const dot = Math.max(3, Math.round(size * 0.3));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.box, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.childRootDot,
          {
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.childConnector,
          {
            left: Math.floor(dot / 2),
            borderColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.childLeafDotTop,
          {
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.childLeafDotBottom,
          {
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: color,
          },
        ]}
      />
    </View>
  );
}

export function ChevronIcon({
  direction,
  color = '#8b949e',
  size = 8,
}: {
  direction: 'right' | 'down' | 'up';
  color?: string;
  size?: number;
}): React.JSX.Element {
  const rotation =
    direction === 'right' ? '-45deg' : direction === 'down' ? '45deg' : '-135deg';
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        iconStyles.chevron,
        {
          width: size,
          height: size,
          borderRightColor: color,
          borderBottomColor: color,
          transform: [{ rotate: rotation }],
        },
      ]}
    />
  );
}

const iconStyles = StyleSheet.create({
  box: {
    position: 'relative',
  },
  markTileTop: {
    position: 'absolute',
    top: 1,
    left: 2,
    borderWidth: 1.75,
    borderRadius: 3,
    transform: [{ rotate: '12deg' }],
  },
  markTileBottom: {
    position: 'absolute',
    bottom: 1,
    right: 2,
    borderWidth: 1.75,
    borderRadius: 3,
    transform: [{ rotate: '12deg' }],
  },
  hostWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1.5,
  },
  hostScreen: {
    borderWidth: 1.25,
    borderRadius: 2,
  },
  hostStand: {
    height: 1.5,
    borderRadius: 1,
  },
  harnessBox: {
    borderWidth: 1.25,
    borderRadius: 3,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  harnessChevron: {
    borderTopWidth: 1.25,
    borderRightWidth: 1.25,
    transform: [{ rotate: '45deg' }],
    marginLeft: -1,
  },
  harnessUnderscore: {
    height: 1.25,
    marginTop: 2,
  },
  branchStem: {
    position: 'absolute',
    top: 1,
    bottom: 1,
    width: 1.4,
  },
  branchDot: {
    position: 'absolute',
  },
  branchDotTopLeft: {
    top: 0,
    left: 0,
  },
  branchDotBottomLeft: {
    bottom: 0,
    left: 0,
  },
  branchDotRight: {
    right: 0,
  },
  branchArm: {
    position: 'absolute',
    borderBottomWidth: 1.4,
    borderRightWidth: 1.4,
    borderBottomRightRadius: 4,
  },
  childRootDot: {
    position: 'absolute',
    top: 1,
    left: 0,
  },
  childConnector: {
    position: 'absolute',
    top: 3,
    bottom: 2,
    right: 3,
    borderLeftWidth: 1.3,
    borderBottomWidth: 1.3,
    borderBottomLeftRadius: 3,
  },
  childLeafDotTop: {
    position: 'absolute',
    top: 2,
    right: 0,
  },
  childLeafDotBottom: {
    position: 'absolute',
    bottom: 1,
    right: 0,
  },
  chevron: {
    borderRightWidth: 1.6,
    borderBottomWidth: 1.6,
  },
});
