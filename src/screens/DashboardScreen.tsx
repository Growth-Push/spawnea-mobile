import React, {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  findNodeHandle,
  Modal,
  PixelRatio,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import {
  defaultApiClient,
  SpawneaApiClient,
} from '../api/client';
import type { SessionSummary } from '../api/types';
import {
  BranchIcon,
  ChevronIcon,
  ChildrenIcon,
  HarnessIcon,
  HostIcon,
  SpawneaMarkIcon,
} from '../dashboard/DashboardIcons';
import {
  computeDistributionSummary,
  DashboardDistributionCategory,
  formatDistributionAccessibilityLabel,
  formatSessionStatusLabel,
  formatSessionTitle,
  partitionDashboardSessions,
} from '../dashboard/dashboardModel';
import { formatHarnessIdentity } from '../sessions/sessionsModel';
import {
  badgeVisuals,
  connectionBadgeLabel,
  errorHeadingForKind,
  StatusChip,
} from '../dashboard/sessionUi';
import {
  DEFAULT_SYNC_POLL_INTERVAL_MS,
  useSessionsSync,
} from '../hooks/useSessionsSync';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../storage/sessionCredentialCache';

export const DEFAULT_DASHBOARD_POLL_INTERVAL_MS = DEFAULT_SYNC_POLL_INTERVAL_MS;

export interface DashboardScreenProps {
  onOpenSettings: () => void;
  onOpenSessions?: () => void;
  onOpenSessionChat?: (sessionId: string) => void;
  apiClient?: SpawneaApiClient;
  credentialCache?: SessionCredentialCache;
  allowDebugLoopback?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
}

function categoryVisuals(category: DashboardDistributionCategory): {
  barBg: string;
  barText: string;
  dot: string;
} {
  switch (category) {
    case 'need-input':
      return {
        barBg: '#f5b952',
        barText: '#111620',
        dot: '#fbbf24',
      };
    case 'running':
      return {
        barBg: '#4ade80',
        barText: '#052e16',
        dot: '#34d399',
      };
    case 'done/idle':
      return {
        barBg: '#64748b',
        barText: '#f8fafc',
        dot: '#94a3b8',
      };
    case 'error':
      return {
        barBg: '#f87171',
        barText: '#1f070a',
        dot: '#f87171',
      };
  }
}

const LEGEND_SURFACE = '#0d1117';
const CHILD_BADGE_RED = '#dc2626';
const CHILD_BADGE_TEXT = '#ffffff';

/** Deterministic badge width so the layout can reserve exactly the room it needs. */
function childBadgeWidth(digits: number, compact?: boolean): number {
  const scale = Math.min(Math.max(PixelRatio.getFontScale(), 1), 1.3);
  const minSize = compact ? 15 : 17;
  const padding = compact ? 2 : 3;
  return Math.max(minSize, Math.ceil(digits * 5.8 * scale) + padding * 2 + 3);
}

/**
 * Small filled notification-style badge for the number of child sessions: circle for
 * one digit, capsule for more. Absolutely anchored over the top-right corner of its
 * parent (the number wrapper); the ring takes the colour of the surface behind it.
 */
function ChildCountBadge({
  count,
  ringColor,
  compact,
  inline,
  anchorRight,
  width,
  testID,
}: {
  count: number | string;
  ringColor: string;
  compact?: boolean;
  inline?: boolean;
  anchorRight?: number;
  width?: number;
  testID?: string;
}): React.JSX.Element {
  return (
    <View
      style={[
        styles.childBadge,
        compact ? styles.childBadgeCompact : styles.childBadgeRegular,
        inline && styles.childBadgeInline,
        anchorRight !== undefined && { right: anchorRight },
        width !== undefined && { width },
        { borderColor: ringColor },
      ]}
      testID={testID}>
      <Text
        style={styles.childBadgeText}
        numberOfLines={1}
        maxFontSizeMultiplier={1.3}>
        {count}
      </Text>
    </View>
  );
}

/**
 * Parent number with the child badge overlapping its top-right corner. Reserves room
 * on the right/top so the badge is never clipped nor covers neighbouring content.
 */
function CountWithBadge({
  parents,
  children: childCount,
  ringColor,
  compact,
  textStyle,
  parentsTestID,
  badgeTestID,
}: {
  parents: number | string;
  children?: number | string | null;
  ringColor: string;
  compact?: boolean;
  textStyle: React.ComponentProps<typeof Text>['style'];
  parentsTestID?: string;
  badgeTestID?: string;
}): React.JSX.Element {
  const hasBadge = childCount !== null && childCount !== undefined;
  // The badge sits just past the number's top-right corner (never over the glyph):
  // reserve exactly its width to the right of the number.
  const badgeWidth = hasBadge
    ? childBadgeWidth(String(childCount).length, compact)
    : 0;
  const reserveRight = badgeWidth;
  return (
    <View
      style={[
        styles.countWrap,
        { marginRight: reserveRight },
      ]}>
      <Text style={textStyle} numberOfLines={1} testID={parentsTestID}>
        {parents}
      </Text>
      {hasBadge ? (
        <ChildCountBadge
          count={childCount as number | string}
          ringColor={ringColor}
          compact={compact}
          anchorRight={-badgeWidth}
          width={badgeWidth}
          testID={badgeTestID}
        />
      ) : null}
    </View>
  );
}

export function DashboardScreen({
  onOpenSettings,
  onOpenSessionChat,
  apiClient = defaultApiClient,
  credentialCache = defaultSessionCredentialCache,
  allowDebugLoopback,
  pollIntervalMs = DEFAULT_DASHBOARD_POLL_INTERVAL_MS,
  now = Date.now,
}: DashboardScreenProps): React.JSX.Element {
  const safeAreaInsets = useContext(SafeAreaInsetsContext);
  const topInset = safeAreaInsets?.top ?? 0;

  const [barUsableWidth, setBarUsableWidth] = useState<number | null>(null);
  const fontScale = PixelRatio.getFontScale();
  const [infoOpen, setInfoOpen] = useState(false);
  const infoTriggerRef = useRef<React.ComponentRef<typeof Pressable>>(null);
  const openInfo = useCallback(() => setInfoOpen(true), []);
  const closeInfo = useCallback(() => {
    setInfoOpen(false);
    // Return accessibility focus to the trigger once the popup is gone.
    setTimeout(() => {
      const handle = findNodeHandle(infoTriggerRef.current);
      if (handle) {
        AccessibilityInfo.setAccessibilityFocus(handle);
      }
    }, 100);
  }, []);
  const [expandedParentIds, setExpandedParentIds] = useState<
    Record<string, boolean>
  >({});

  const clearExpandedChildren = useCallback(() => {
    setExpandedParentIds({});
  }, []);

  const {
    viewState,
    activeSnapshot,
    isFocused,
    isManualRefreshing,
    isBackgroundRefreshing,
    pollRemainingSeconds,
    handleManualRefresh,
    handleToggleBadgePopup,
  } = useSessionsSync({
    apiClient,
    credentialCache,
    allowDebugLoopback,
    pollIntervalMs,
    now,
    promptSubtitle: 'Unlock your saved API key to load live Spawnea sessions',
    onClearPrivateUiState: clearExpandedChildren,
  });

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      onOpenSessionChat?.(sessionId);
    },
    [onOpenSessionChat],
  );

  const handleToggleChildren = useCallback((parentId: string) => {
    setExpandedParentIds(prev => ({
      ...prev,
      [parentId]: !prev[parentId],
    }));
  }, []);

  const summary = useMemo(
    () =>
      activeSnapshot
        ? computeDistributionSummary(activeSnapshot.sessions)
        : null,
    [activeSnapshot],
  );

  const { needsInput, otherSessions, childrenByParentId, parentTitleById } =
    useMemo(
      () =>
        activeSnapshot
          ? partitionDashboardSessions(activeSnapshot.sessions)
          : {
              needsInput: [],
              otherSessions: [],
              childrenByParentId: new Map<string, SessionSummary[]>(),
              parentTitleById: new Map<string, string>(),
            },
      [activeSnapshot],
    );

  const isStale = viewState.status === 'stale';
  const badgeStyle = badgeVisuals(viewState);
  const badgeLabel = connectionBadgeLabel(viewState);

  return (
    <View
      style={[styles.screenRoot, { paddingTop: topInset }]}
      testID="dashboard-root">
      {isFocused ? <StatusBar barStyle="light-content" /> : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        testID="dashboard-screen"
        refreshControl={
          <RefreshControl
            refreshing={isManualRefreshing}
            onRefresh={handleManualRefresh}
            colors={['#a78bfa', '#34d399']}
            progressBackgroundColor="#161b22"
            tintColor="#a78bfa"
          />
        }>

      <View style={styles.headerBlock} testID="dashboard-header">
        <View style={styles.headerRow}>
          <View style={styles.headerTitleGroup}>
            <SpawneaMarkIcon color="#a78bfa" size={20} />
            <Text style={styles.headerTitle}>Dashboard</Text>
          </View>

          <Pressable
            testID="dashboard-connection-badge"
            accessibilityRole="button"
            accessibilityLabel={`Connection status: ${badgeLabel}`}
            onPress={handleToggleBadgePopup}
            style={[styles.connectionBadge, badgeStyle.container]}>
            <View
              style={[styles.connectionDot, { backgroundColor: badgeStyle.dot }]}
            />
            <Text
              style={[styles.connectionBadgeText, { color: badgeStyle.text }]}
              testID="dashboard-connection-status">
              {badgeLabel}
            </Text>
            {isBackgroundRefreshing && !isManualRefreshing ? (
              <ActivityIndicator
                size="small"
                color={badgeStyle.text}
                style={styles.badgeSpinner}
              />
            ) : null}
          </Pressable>
        </View>

        {pollRemainingSeconds !== null ? (
          <View
            style={styles.pollPopup}
            testID="dashboard-poll-countdown-popup">
            <Text
              style={styles.pollPopupText}
              testID="dashboard-poll-countdown-text">
              Refresh in {pollRemainingSeconds} s
            </Text>
          </View>
        ) : null}
      </View>

      {isStale ? (
        <View style={styles.staleBanner} testID="dashboard-stale-banner">
          <View style={styles.bannerHeaderRow}>
            <View style={styles.staleBadgeDot} />
            <Text
              style={styles.staleBannerHeading}
              testID="dashboard-stale-heading">
              Stale data · Not live
            </Text>
          </View>
          <Text style={styles.staleBannerBody} testID="dashboard-stale-reason">
            Showing cached snapshot while live refresh is unavailable:{' '}
            {viewState.staleReason} Pull down to refresh.
          </Text>
          {viewState.errorKind === 'auth_rejected' ? (
            <Pressable
              testID="dashboard-stale-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>Open Settings</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {viewState.status === 'not_configured' ? (
        <View style={styles.card} testID="dashboard-not-configured-card">
          <Text style={styles.cardHeading}>
            {viewState.reason === 'incomplete_config'
              ? 'Incomplete configuration'
              : viewState.reason === 'invalid_url'
              ? 'Invalid server URL'
              : 'Not configured'}
          </Text>
          <Text style={styles.cardBody} testID="dashboard-config-status">
            {viewState.message}
          </Text>
          <Pressable
            testID="dashboard-config-open-settings-button"
            accessibilityRole="button"
            style={styles.primaryButton}
            onPress={onOpenSettings}>
            <Text style={styles.primaryButtonText}>Open Settings</Text>
          </Pressable>
        </View>
      ) : null}

      {viewState.status === 'locked' ? (
        <View style={styles.card} testID="dashboard-locked-card">
          <Text style={styles.cardHeading}>
            {viewState.reason === 'auth_invalidated'
              ? 'Re-link required'
              : 'Biometric unlock required'}
          </Text>
          <Text style={styles.cardBody} testID="dashboard-locked-message">
            {viewState.message}
          </Text>
          {viewState.reason === 'auth_invalidated' ||
          viewState.reason === 'no_biometrics_enrolled' ||
          viewState.reason === 'biometric_unavailable' ? (
            <Pressable
              testID="dashboard-locked-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>Open Settings</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="dashboard-unlock-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={handleManualRefresh}>
              <Text style={styles.primaryButtonText}>Unlock Dashboard</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {viewState.status === 'loading' ? (
        <View style={styles.card} testID="dashboard-loading-card">
          <ActivityIndicator size="small" color="#a78bfa" />
          <Text style={styles.cardHeading}>Loading</Text>
          <Text style={styles.cardBody}>{viewState.message}</Text>
        </View>
      ) : null}

      {viewState.status === 'error' ? (
        <View style={styles.errorCard} testID="dashboard-error-card">
          <Text style={styles.errorCardHeading}>
            {errorHeadingForKind(viewState.error.kind)}
          </Text>
          <Text style={styles.errorCardBody} testID="dashboard-error-message">
            {viewState.error.message}
          </Text>
          {viewState.error.kind === 'auth_rejected' ? (
            <Pressable
              testID="dashboard-error-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>
                Open Settings to Replace Key
              </Text>
            </Pressable>
          ) : (
            <Pressable
              testID="dashboard-error-retry-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={handleManualRefresh}>
              <Text style={styles.primaryButtonText}>Retry</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {activeSnapshot && summary ? (
        <>
          <Modal
            visible={infoOpen}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={closeInfo}
            testID="dashboard-distribution-info-modal">
            <Pressable
              style={styles.infoBackdrop}
              onPress={closeInfo}
              accessible={false}
              testID="dashboard-distribution-info-backdrop">
              <View
                style={styles.infoPopup}
                accessibilityViewIsModal
                testID="dashboard-distribution-info-popup"
                onStartShouldSetResponder={() => true}>
                <Text style={styles.infoTitle} accessibilityRole="header">
                  Session counts
                </Text>
                <Text style={styles.infoLine}>Number = parent sessions</Text>
                <View style={styles.infoLineRow}>
                  <ChildCountBadge count="n" ringColor="#161b22" inline />
                  <Text style={styles.infoLine}>Red badge = child sessions</Text>
                </View>
                <Text style={styles.infoLine}>
                  Total and bar include all sessions
                </Text>
                <Pressable
                  testID="dashboard-distribution-info-close"
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  style={styles.infoClose}
                  onPress={closeInfo}>
                  <Text style={styles.infoCloseText}>Close</Text>
                </Pressable>
              </View>
            </Pressable>
          </Modal>
          <View style={styles.card} testID="dashboard-summary-card">
            <View style={styles.summaryHeaderRow}>
              <View style={styles.summaryTitleGroup}>
                <Text style={styles.summaryHeading}>Session distribution</Text>
                <Pressable
                  ref={infoTriggerRef}
                  testID="dashboard-distribution-info-trigger"
                  accessibilityRole="button"
                  accessibilityLabel="About session counts"
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                  style={styles.infoTrigger}
                  onPress={openInfo}>
                  <Text style={styles.infoTriggerGlyph}>ⓘ</Text>
                </Pressable>
              </View>
              <Text
                style={styles.totalCountText}
                testID="dashboard-total-sessions">
                Total: {summary.total}
              </Text>
            </View>

            <View
              style={[
                styles.distributionBarTrack,
                summary.total === 0 && styles.distributionBarTrackEmpty,
              ]}
              onLayout={event => {
                const nextUsableWidth = Math.max(
                  0,
                  event.nativeEvent.layout.width - 2,
                );
                setBarUsableWidth(prev =>
                  prev !== null && Math.abs(prev - nextUsableWidth) < 0.5
                    ? prev
                    : nextUsableWidth,
                );
              }}
              testID="dashboard-distribution-bar">
              {summary.categories
                .filter(item => item.count > 0)
                .map(item => {
                  const visuals = categoryVisuals(item.category);
                  const ratio =
                    summary.total > 0 ? item.count / summary.total : 0;
                  const widthPercent = ratio * 100;
                  const parentText = String(item.parentCount);
                  const childText = String(item.childCount);
                  // Parent number + (when there are children) the overlapping badge.
                  const minNeededWidthDp =
                    parentText.length * 9 * fontScale +
                    (item.childCount > 0
                      ? childBadgeWidth(childText.length, true)
                      : 0) +
                    8;
                  const segmentWidthDp =
                    barUsableWidth !== null ? barUsableWidth * ratio : null;
                  const showSegmentCount =
                    segmentWidthDp !== null
                      ? segmentWidthDp >= minNeededWidthDp
                      : ratio >= 0.1 && item.childCount === 0;

                  return (
                    <View
                      key={item.category}
                      testID={`dashboard-bar-segment-${item.category}`}
                      accessible
                      accessibilityLabel={formatDistributionAccessibilityLabel(item)}
                      style={[
                        styles.distributionBarSegment,
                        {
                          width: `${widthPercent}%`,
                          backgroundColor: visuals.barBg,
                        },
                      ]}>
                      {showSegmentCount ? (
                        <CountWithBadge
                          parents={item.parentCount}
                          children={item.childCount > 0 ? item.childCount : null}
                          ringColor={visuals.barBg}
                          compact
                          textStyle={[
                            styles.distributionBarText,
                            { color: visuals.barText },
                          ]}
                          badgeTestID={`dashboard-bar-child-badge-${item.category}`}
                        />
                      ) : null}
                    </View>
                  );
                })}
            </View>

            <View
              style={styles.legendRow}
              testID="dashboard-distribution-legend">
              {summary.categories.map(item => {
                const visuals = categoryVisuals(item.category);
                return (
                  <View
                    key={item.category}
                    style={styles.legendItem}
                    testID={`dashboard-legend-item-${item.category}`}
                    accessible
                    accessibilityLabel={formatDistributionAccessibilityLabel(
                      item,
                    )}>
                    <View
                      style={[styles.legendDot, { backgroundColor: visuals.dot }]}
                    />
                    <CountWithBadge
                      parents={item.parentCount}
                      children={item.childCount > 0 ? item.childCount : null}
                      ringColor={LEGEND_SURFACE}
                      textStyle={styles.legendNumber}
                      parentsTestID={`dashboard-distribution-parents-${item.category}`}
                      badgeTestID={`dashboard-distribution-children-${item.category}`}
                    />
                    <Text
                      style={styles.legendText}
                      testID={`dashboard-legend-${item.category}`}>
                      {item.label}
                    </Text>
                  </View>
                );
              })}
            </View>

            {summary.unknownCount > 0 ? (
              <View
                style={styles.unknownStatusNotice}
                testID="dashboard-unknown-status-notice">
                <Text style={styles.unknownStatusNoticeText}>
                  {summary.unknownCount}{' '}
                  {summary.unknownCount === 1 ? 'session' : 'sessions'} with
                  unknown status
                </Text>
              </View>
            ) : null}
          </View>

          {activeSnapshot.sessions.length === 0 ? (
            isStale ? (
              <View style={styles.card} testID="dashboard-stale-empty-card">
                <Text style={styles.cardHeading}>
                  0 sessions (last known · not live)
                </Text>
                <Text style={styles.cardBody}>
                  The previous sync reported 0 sessions. Current sessions are
                  unknown while live refresh is unavailable.
                </Text>
              </View>
            ) : (
              <View style={styles.card} testID="dashboard-empty-card">
                <Text style={styles.cardHeading}>0 sessions</Text>
                <Text style={styles.cardBody}>
                  No sessions are currently reported by this Spawnea server.
                </Text>
              </View>
            )
          ) : (
            <>
              {needsInput.length > 0 ? (
                <View
                  style={styles.needsInputSection}
                  testID="dashboard-needs-input-section">
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>Needs input</Text>
                    <View style={styles.needsInputCountBadge}>
                      <Text
                        style={styles.needsInputCountText}
                        testID="dashboard-needs-input-count">
                        {needsInput.length}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.sessionList}>
                    {needsInput.map(session => {
                      const parentTitle = session.parentSessionId
                        ? parentTitleById.get(session.parentSessionId)
                        : undefined;
                      return (
                        <SessionCard
                          key={session.id}
                          session={session}
                          emphasized
                          childrenSessions={
                            childrenByParentId.get(session.id) ?? []
                          }
                          isExpanded={Boolean(expandedParentIds[session.id])}
                          parentTitle={parentTitle}
                          onToggleChildren={handleToggleChildren}
                          onPress={handleOpenSession}
                        />
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {otherSessions.length > 0 ? (
                <View
                  style={styles.sessionsSection}
                  testID="dashboard-other-sessions-section">
                  <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionTitle}>Sessions</Text>
                    <View style={styles.sectionCountBadge}>
                      <Text style={styles.sectionCountText}>
                        {otherSessions.length}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.sessionList}>
                    {otherSessions.map(session => (
                      <SessionCard
                        key={session.id}
                        session={session}
                        emphasized={false}
                        childrenSessions={
                          childrenByParentId.get(session.id) ?? []
                        }
                        isExpanded={Boolean(expandedParentIds[session.id])}
                        onToggleChildren={handleToggleChildren}
                        onPress={handleOpenSession}
                      />
                    ))}
                  </View>
                </View>
              ) : null}
            </>
          )}
        </>
      ) : null}
      </ScrollView>
    </View>
  );
}

function SessionCard({
  session,
  emphasized,
  childrenSessions,
  isExpanded,
  parentTitle,
  onToggleChildren,
  onPress,
}: {
  session: SessionSummary;
  emphasized: boolean;
  childrenSessions: SessionSummary[];
  isExpanded: boolean;
  parentTitle?: string;
  onToggleChildren: (parentId: string) => void;
  onPress: (sessionId: string) => void;
}): React.JSX.Element {
  const title = formatSessionTitle(session);
  const trimmedTask = session.task.trim();
  const showTaskSubtitle = trimmedTask.length > 0 && trimmedTask !== title;
  const hostLabel = session.host.name.trim() || session.host.id;
  const harnessIdentity = formatHarnessIdentity(session);
  const branchLabel = session.worktree?.branch?.trim() || null;

  return (
    <View
      style={[
        styles.sessionCardWrapper,
        emphasized && styles.sessionCardWrapperNeedsInput,
      ]}>
      <Pressable
        testID={`dashboard-session-card-${session.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${formatSessionStatusLabel(session.status)}`}
        style={styles.sessionCardPressable}
        onPress={() => onPress(session.id)}>
        <View style={styles.sessionCardHeader}>
          <Text style={styles.sessionTitle} numberOfLines={2}>
            {title}
          </Text>
          <View style={styles.sessionHeaderRight}>
            <StatusChip status={session.status} />
            <ChevronIcon direction="right" color="#6e7681" size={8} />
          </View>
        </View>

        {showTaskSubtitle ? (
          <Text style={styles.sessionTask} numberOfLines={2}>
            {trimmedTask}
          </Text>
        ) : null}

        <View style={styles.metaRow}>
          <View
            style={styles.metaItem}
            accessible
            accessibilityLabel={`Host: ${hostLabel}`}>
            <HostIcon color="#8b949e" size={12} hostName={hostLabel} />
            <Text style={styles.metaText}>{hostLabel}</Text>
          </View>

          <View
            style={styles.metaItem}
            accessible
            accessibilityLabel={harnessIdentity.accessibilityLabel}>
            <HarnessIcon
              color="#a78bfa"
              size={12}
              harnessId={session.harness.id}
              harnessName={session.harness.name}
              harnessCommand={session.harness.command}
            />
            <Text style={styles.metaText} numberOfLines={2}>
              {harnessIdentity.label}
            </Text>
          </View>

          {branchLabel ? (
            <View
              style={[styles.metaItem, styles.metaBranchItem]}
              accessible
              accessibilityLabel={`Branch: ${branchLabel}`}>
              <BranchIcon color="#93c5fd" size={12} />
              <Text style={styles.metaBranchText}>{branchLabel}</Text>
            </View>
          ) : null}

          {parentTitle ? (
            <View
              style={styles.metaItem}
              accessible
              accessibilityLabel={`Parent session: ${parentTitle}`}>
              <ChildrenIcon color="#c4b5fd" size={12} />
              <Text style={styles.metaText}>Parent: {parentTitle}</Text>
            </View>
          ) : null}
        </View>
      </Pressable>

      {childrenSessions.length > 0 ? (
        <View style={styles.childrenFooter}>
          <Pressable
            testID={`dashboard-children-toggle-${session.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${childrenSessions.length} ${
              childrenSessions.length === 1 ? 'child' : 'children'
            }. ${isExpanded ? 'Collapse' : 'Expand'} child sessions`}
            style={styles.childrenChip}
            onPress={() => onToggleChildren(session.id)}>
            <ChildrenIcon color="#c4b5fd" size={12} />
            <Text style={styles.childrenChipText}>
              {childrenSessions.length}{' '}
              {childrenSessions.length === 1 ? 'child' : 'children'}
            </Text>
            <ChevronIcon
              direction={isExpanded ? 'up' : 'down'}
              color="#c4b5fd"
              size={7}
            />
          </Pressable>

          {isExpanded ? (
            <View
              style={styles.childrenList}
              testID={`dashboard-children-list-${session.id}`}>
              {(() => {
                const needsInputChildren = childrenSessions.filter(
                  child => child.status === 'needs_input',
                );
                const inlineChildren = childrenSessions.filter(
                  child => child.status !== 'needs_input',
                );
                return (
                  <>
                    {needsInputChildren.length > 0 ? (
                      <View
                        style={styles.childNeedsInputRef}
                        testID={`dashboard-children-needs-input-ref-${session.id}`}
                        accessible
                        accessibilityLabel={`${needsInputChildren.length} waiting in Need input`}>
                        <View style={styles.childNeedsInputRefDot} />
                        <Text style={styles.childNeedsInputRefText}>
                          {needsInputChildren.length} waiting in Need input
                        </Text>
                      </View>
                    ) : null}
                    {inlineChildren.map(child => {
                      const childTitle = formatSessionTitle(child);
                      const childHost =
                        child.host.name.trim() || child.host.id;
                      const childIdentity = formatHarnessIdentity(child);
                      const childBranch = child.worktree?.branch?.trim() || null;
                      return (
                        <Pressable
                          key={child.id}
                          testID={`dashboard-child-card-${child.id}`}
                          accessibilityRole="button"
                          accessibilityLabel={`${childTitle}, ${formatSessionStatusLabel(child.status)}`}
                          style={styles.childRow}
                          onPress={() => onPress(child.id)}>
                          <View style={styles.childRowHeader}>
                            <Text style={styles.childTitle} numberOfLines={2}>
                              {childTitle}
                            </Text>
                            <View style={styles.sessionHeaderRight}>
                              <StatusChip status={child.status} />
                              <ChevronIcon
                                direction="right"
                                color="#6e7681"
                                size={7}
                              />
                            </View>
                          </View>
                          <View style={styles.metaRow}>
                            <View
                              style={styles.metaItem}
                              accessible
                              accessibilityLabel={`Host: ${childHost}`}>
                              <HostIcon
                                color="#8b949e"
                                size={11}
                                hostName={childHost}
                              />
                              <Text style={styles.metaText}>{childHost}</Text>
                            </View>
                            <View
                              style={styles.metaItem}
                              accessible
                              accessibilityLabel={childIdentity.accessibilityLabel}>
                              <HarnessIcon
                                color="#a78bfa"
                                size={11}
                                harnessId={child.harness.id}
                                harnessName={child.harness.name}
                                harnessCommand={child.harness.command}
                              />
                              <Text style={styles.metaText} numberOfLines={2}>
                                {childIdentity.label}
                              </Text>
                            </View>
                            {childBranch ? (
                              <View
                                style={[styles.metaItem, styles.metaBranchItem]}
                                accessible
                                accessibilityLabel={`Branch: ${childBranch}`}>
                                <BranchIcon color="#93c5fd" size={11} />
                                <Text style={styles.metaBranchText}>
                                  {childBranch}
                                </Text>
                              </View>
                            ) : null}
                          </View>
                        </Pressable>
                      );
                    })}
                  </>
                );
              })()}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screenRoot: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  scroll: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  container: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 28,
    gap: 14,
  },
  headerBlock: {
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  headerTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#f0f6fc',
    letterSpacing: -0.2,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    flexShrink: 1,
    maxWidth: '100%',
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connectionBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    flexShrink: 1,
  },
  badgeSpinner: {
    marginLeft: 2,
  },
  pollPopup: {
    alignSelf: 'flex-end',
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  pollPopupText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  staleBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d97706',
    padding: 12,
    gap: 8,
  },
  bannerHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  staleBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fbbf24',
  },
  staleBannerHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fde68a',
    flexShrink: 1,
  },
  staleBannerBody: {
    fontSize: 13,
    lineHeight: 19,
    color: '#fcd34d',
  },
  card: {
    backgroundColor: '#111620',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#21262d',
    padding: 14,
    gap: 10,
  },
  errorCard: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dc2626',
    padding: 14,
    gap: 10,
  },
  cardHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  cardBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#9ca3af',
  },
  errorCardHeading: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fecaca',
  },
  errorCardBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#fca5a5',
  },
  summaryHeaderRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  summaryHeading: {
    fontSize: 14,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  totalCountText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#cbd5e1',
  },
  distributionBarTrack: {
    height: 28,
    borderRadius: 8,
    overflow: 'hidden',
    flexDirection: 'row',
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#21262d',
  },
  distributionBarTrackEmpty: {
    height: 12,
  },
  distributionBarSegment: {
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  distributionBarText: {
    fontSize: 13,
    fontWeight: '800',
  },
  legendRow: {
    paddingTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: 10,
    rowGap: 6,
  },
  unknownStatusNotice: {
    alignSelf: 'flex-start',
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  unknownStatusNoticeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  legendNumber: {
    fontSize: 13,
    fontWeight: '800',
    color: '#f0f6fc',
  },
  countWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  childBadge: {
    position: 'absolute',
    backgroundColor: CHILD_BADGE_RED,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  childBadgeRegular: {
    top: -9,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 3,
  },
  childBadgeCompact: {
    top: -1,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 2,
  },
  childBadgeInline: {
    position: 'relative',
    top: 0,
    right: 0,
  },
  childBadgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    color: CHILD_BADGE_TEXT,
    includeFontPadding: false,
  },
  summaryTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 1,
  },
  infoTrigger: {
    minWidth: 48,
    minHeight: 48,
    marginVertical: -14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoTriggerGlyph: {
    fontSize: 16,
    color: '#9ca3af',
  },
  infoBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(1, 4, 9, 0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  infoPopup: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 4,
    gap: 10,
  },
  infoTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  infoLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoLine: {
    fontSize: 13,
    color: '#cbd5e1',
    flexShrink: 1,
  },
  infoClose: {
    alignSelf: 'flex-end',
    marginTop: -4,
    minHeight: 48,
    minWidth: 48,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoCloseText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#a78bfa',
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  needsInputSection: {
    backgroundColor: 'rgba(245, 158, 11, 0.06)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(217, 119, 6, 0.55)',
    padding: 12,
    gap: 10,
  },
  sessionsSection: {
    gap: 10,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  needsInputCountBadge: {
    backgroundColor: '#f5b952',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
  },
  needsInputCountText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#111620',
  },
  sectionCountBadge: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
  },
  sectionCountText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9ca3af',
  },
  sessionList: {
    gap: 10,
  },
  sessionCardWrapper: {
    backgroundColor: '#161b22',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#30363d',
    overflow: 'hidden',
  },
  sessionCardWrapperNeedsInput: {
    backgroundColor: '#181b22',
    borderColor: '#d97706',
    borderWidth: 1.5,
  },
  sessionCardPressable: {
    padding: 12,
    gap: 8,
  },
  sessionCardHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  sessionTitle: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 140,
    fontSize: 15,
    fontWeight: '700',
    color: '#f0f6fc',
  },
  sessionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
  sessionTask: {
    fontSize: 13,
    color: '#9ca3af',
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 10,
    rowGap: 6,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
    maxWidth: '100%',
  },
  metaBranchItem: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(96, 165, 250, 0.25)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  metaText: {
    fontSize: 12,
    color: '#9ca3af',
    flexShrink: 1,
  },
  metaBranchText: {
    fontSize: 12,
    color: '#bfdbfe',
    fontWeight: '600',
    flexShrink: 1,
  },
  childrenFooter: {
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    backgroundColor: '#111620',
  },
  childrenChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(139, 92, 246, 0.16)',
    borderWidth: 1,
    borderColor: '#7c3aed',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  childrenChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ddd6fe',
  },
  childrenList: {
    borderLeftWidth: 2,
    borderLeftColor: '#6d28d9',
    paddingLeft: 10,
    gap: 8,
  },
  childNeedsInputRef: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  childNeedsInputRefDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#fbbf24',
  },
  childNeedsInputRefText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fcd34d',
  },
  childRow: {
    backgroundColor: '#0d1117',
    borderWidth: 1,
    borderColor: '#21262d',
    borderRadius: 8,
    padding: 9,
    gap: 5,
  },
  childRowHeader: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  childTitle: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 120,
    fontSize: 13,
    fontWeight: '600',
    color: '#e6edf3',
  },
  primaryButton: {
    backgroundColor: '#7c3aed',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
});
