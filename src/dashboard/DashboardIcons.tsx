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

export function ProjectIcon({
  color = '#8b949e',
  size = 12,
}: IconProps): React.JSX.Element {
  const tabW = Math.max(4, Math.round(size * 0.44));
  const bodyH = Math.max(7, Math.round(size * 0.68));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.projectWrap, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.projectTab,
          { width: tabW, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.projectBody,
          { width: size, height: bodyH, borderColor: color },
        ]}
      />
    </View>
  );
}

export function ActivityIcon({
  color = '#8b949e',
  size = 12,
}: IconProps): React.JSX.Element {
  const handV = Math.max(3, Math.round(size * 0.28));
  const handH = Math.max(3, Math.round(size * 0.26));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        iconStyles.clockRing,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: color,
        },
      ]}>
      <View
        style={[
          iconStyles.clockHandVertical,
          { height: handV, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.clockHandHorizontal,
          { width: handH, backgroundColor: color },
        ]}
      />
    </View>
  );
}

export function BackArrowIcon({
  color = '#f0f6fc',
  size = 16,
}: IconProps): React.JSX.Element {
  const head = Math.max(6, Math.round(size * 0.45));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.backWrap, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.backHead,
          {
            width: head,
            height: head,
            borderLeftColor: color,
            borderBottomColor: color,
          },
        ]}
      />
      <View
        style={[
          iconStyles.backShaft,
          { width: Math.max(8, size - 4), backgroundColor: color },
        ]}
      />
    </View>
  );
}

export function SendIcon({
  color = '#ffffff',
  size = 14,
}: IconProps): React.JSX.Element {
  const head = Math.max(6, Math.round(size * 0.48));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[iconStyles.sendWrap, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.sendShaft,
          { height: Math.max(7, size - 4), backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.sendHead,
          {
            width: head,
            height: head,
            borderTopColor: color,
            borderLeftColor: color,
          },
        ]}
      />
    </View>
  );
}

export function ToolIcon({
  color = '#8b949e',
  size = 12,
}: IconProps): React.JSX.Element {
  const barW = Math.max(6, Math.round(size * 0.65));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        iconStyles.toolBox,
        { width: size, height: size, borderColor: color },
      ]}>
      <View
        style={[
          iconStyles.toolBar,
          { width: barW, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.toolBar,
          { width: Math.max(4, Math.round(barW * 0.7)), backgroundColor: color },
        ]}
      />
    </View>
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
  projectWrap: {
    justifyContent: 'flex-end',
  },
  projectTab: {
    height: 2,
    borderTopLeftRadius: 1.5,
    borderTopRightRadius: 1.5,
    marginBottom: -1,
  },
  projectBody: {
    borderWidth: 1.25,
    borderRadius: 2,
  },
  clockRing: {
    borderWidth: 1.25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockHandVertical: {
    position: 'absolute',
    width: 1.25,
    top: '24%',
  },
  clockHandHorizontal: {
    position: 'absolute',
    height: 1.25,
    left: '48%',
  },
  backWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backHead: {
    borderLeftWidth: 1.8,
    borderBottomWidth: 1.8,
    transform: [{ rotate: '45deg' }],
    marginRight: -6,
  },
  backShaft: {
    height: 1.8,
    borderRadius: 1,
  },
  sendWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendShaft: {
    width: 1.8,
    borderRadius: 1,
  },
  sendHead: {
    position: 'absolute',
    top: 2,
    borderTopWidth: 1.8,
    borderLeftWidth: 1.8,
    transform: [{ rotate: '45deg' }],
  },
  toolBox: {
    borderWidth: 1.2,
    borderRadius: 2.5,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: 1.5,
    gap: 1.5,
  },
  toolBar: {
    height: 1.3,
    borderRadius: 0.5,
  },
});
