import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { defaultApiClient, SpawneaApiClient } from '../api/client';
import type { SessionSummary } from '../api/types';
import {
  ActivityIcon,
  BranchIcon,
  ChevronIcon,
  ChildrenIcon,
  HarnessIcon,
  HostIcon,
  ProjectIcon,
  SpawneaMarkIcon,
} from '../dashboard/DashboardIcons';
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
  buildSessionsListTree,
  computeSessionsHeaderSummary,
  formatChildrenToggleLabels,
  formatHarnessIdentity,
  formatHostName,
  formatProjectName,
  formatRelativeActivity,
  formatSessionStatusLabel,
  formatSessionTitle,
  SESSION_FILTER_OPTIONS,
  SessionFilterKey,
} from '../sessions/sessionsModel';
import {
  defaultSessionCredentialCache,
  SessionCredentialCache,
} from '../storage/sessionCredentialCache';

const RELATIVE_TIME_TICK_MS = 60000;

export interface SessionsScreenProps {
  onOpenSessionChat: (sessionId: string) => void;
  onOpenSettings: () => void;
  apiClient?: SpawneaApiClient;
  credentialCache?: SessionCredentialCache;
  allowDebugLoopback?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
}

export function SessionsScreen({
  onOpenSessionChat,
  onOpenSettings,
  apiClient = defaultApiClient,
  credentialCache = defaultSessionCredentialCache,
  allowDebugLoopback,
  pollIntervalMs = DEFAULT_SYNC_POLL_INTERVAL_MS,
  now = Date.now,
}: SessionsScreenProps): React.JSX.Element {
  const safeAreaInsets = useContext(SafeAreaInsetsContext);
  const topInset = safeAreaInsets?.top ?? 0;

  const [activeFilter, setActiveFilter] = useState<SessionFilterKey>('all');
  const [expandedOverrides, setExpandedOverrides] = useState<
    Record<string, boolean>
  >({});
  const [activityNowMs, setActivityNowMs] = useState<number>(() => now());

  const clearPrivateUiState = useCallback(() => {
    setExpandedOverrides({});
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
    onClearPrivateUiState: clearPrivateUiState,
  });

  useEffect(() => {
    if (activeSnapshot) {
      setActivityNowMs(now());
    }
  }, [activeSnapshot, now]);

  useEffect(() => {
    if (!isFocused || !activeSnapshot) {
      return;
    }
    const timer = setInterval(() => {
      setActivityNowMs(now());
    }, RELATIVE_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, [activeSnapshot, isFocused, now]);

  const headerSummary = useMemo(
    () =>
      activeSnapshot
        ? computeSessionsHeaderSummary(activeSnapshot.sessions)
        : null,
    [activeSnapshot],
  );

  const tree = useMemo(
    () =>
      activeSnapshot
        ? buildSessionsListTree(activeSnapshot.sessions, activeFilter)
        : null,
    [activeSnapshot, activeFilter],
  );

  const handleToggleChildren = useCallback(
    (parentId: string, currentExpanded: boolean) => {
      setExpandedOverrides(prev => ({
        ...prev,
        [parentId]: !currentExpanded,
      }));
    },
    [],
  );

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      onOpenSessionChat(sessionId);
    },
    [onOpenSessionChat],
  );

  const isStale = viewState.status === 'stale';
  const badgeStyle = badgeVisuals(viewState);
  const badgeLabel = connectionBadgeLabel(viewState);
  const activeFilterLabel =
    SESSION_FILTER_OPTIONS.find(option => option.key === activeFilter)?.label ??
    'All';

  return (
    <View
      style={[styles.screenRoot, { paddingTop: topInset }]}
      testID="sessions-root">
      {isFocused ? <StatusBar barStyle="light-content" /> : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.container}
        testID="sessions-screen"
        refreshControl={
          <RefreshControl
            refreshing={isManualRefreshing}
            onRefresh={handleManualRefresh}
            colors={['#a78bfa', '#34d399']}
            progressBackgroundColor="#161b22"
            tintColor="#a78bfa"
          />
        }>
        <View style={styles.headerBlock} testID="sessions-header">
          <View style={styles.headerRow}>
            <View style={styles.headerTitleGroup}>
              <SpawneaMarkIcon color="#a78bfa" size={20} />
              <Text style={styles.headerTitle}>Sessions</Text>
            </View>

            <Pressable
              testID="sessions-connection-badge"
              accessibilityRole="button"
              accessibilityLabel={`Connection status: ${badgeLabel}`}
              onPress={handleToggleBadgePopup}
              style={[styles.connectionBadge, badgeStyle.container]}>
              <View
                style={[styles.connectionDot, { backgroundColor: badgeStyle.dot }]}
              />
              <Text
                style={[styles.connectionBadgeText, { color: badgeStyle.text }]}
                testID="sessions-connection-status">
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

          {headerSummary ? (
            <View
              style={styles.headerSummaryRow}
              testID="sessions-header-summary">
              <View style={styles.headerMetaChip}>
                <Text
                  style={styles.headerMetaText}
                  testID="sessions-count-summary">
                  {headerSummary.sessionCount}{' '}
                  {headerSummary.sessionCount === 1 ? 'session' : 'sessions'}
                </Text>
              </View>
              <View style={styles.headerMetaChip}>
                <HostIcon color="#8b949e" size={12} />
                <Text
                  style={styles.headerMetaText}
                  testID="sessions-hosts-summary">
                  {headerSummary.hostCount}{' '}
                  {headerSummary.hostCount === 1 ? 'host' : 'hosts'}
                </Text>
              </View>
              {headerSummary.needsInputCount > 0 ? (
                <View
                  style={styles.headerNeedsInputBadge}
                  testID="sessions-needs-input-counter">
                  <View style={styles.headerNeedsInputDot} />
                  <Text style={styles.headerNeedsInputText}>
                    {headerSummary.needsInputCount} need input
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {pollRemainingSeconds !== null ? (
            <View
              style={styles.pollPopup}
              testID="sessions-poll-countdown-popup">
              <Text
                style={styles.pollPopupText}
                testID="sessions-poll-countdown-text">
                Refresh in {pollRemainingSeconds} s
              </Text>
            </View>
          ) : null}
        </View>

        {isStale ? (
          <View style={styles.staleBanner} testID="sessions-stale-banner">
            <View style={styles.bannerHeaderRow}>
              <View style={styles.staleBadgeDot} />
              <Text
                style={styles.staleBannerHeading}
                testID="sessions-stale-heading">
                Stale data · Not live
              </Text>
            </View>
            <Text style={styles.staleBannerBody} testID="sessions-stale-reason">
              Showing cached snapshot while live refresh is unavailable:{' '}
              {viewState.staleReason} Pull down to refresh.
            </Text>
            {viewState.errorKind === 'auth_rejected' ? (
              <Pressable
                testID="sessions-stale-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>Open Settings</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {viewState.status === 'not_configured' ? (
          <View style={styles.card} testID="sessions-not-configured-card">
            <Text style={styles.cardHeading}>
              {viewState.reason === 'incomplete_config'
                ? 'Incomplete configuration'
                : viewState.reason === 'invalid_url'
                  ? 'Invalid server URL'
                  : 'Not configured'}
            </Text>
            <Text style={styles.cardBody} testID="sessions-config-status">
              {viewState.message}
            </Text>
            <Pressable
              testID="sessions-config-open-settings-button"
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={onOpenSettings}>
              <Text style={styles.primaryButtonText}>Open Settings</Text>
            </Pressable>
          </View>
        ) : null}

        {viewState.status === 'locked' ? (
          <View style={styles.card} testID="sessions-locked-card">
            <Text style={styles.cardHeading}>
              {viewState.reason === 'auth_invalidated'
                ? 'Re-link required'
                : 'Biometric unlock required'}
            </Text>
            <Text style={styles.cardBody} testID="sessions-locked-message">
              {viewState.message}
            </Text>
            {viewState.reason === 'auth_invalidated' ||
            viewState.reason === 'no_biometrics_enrolled' ||
            viewState.reason === 'biometric_unavailable' ? (
              <Pressable
                testID="sessions-locked-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>Open Settings</Text>
              </Pressable>
            ) : (
              <Pressable
                testID="sessions-unlock-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={handleManualRefresh}>
                <Text style={styles.primaryButtonText}>Unlock Sessions</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {viewState.status === 'loading' ? (
          <View style={styles.card} testID="sessions-loading-card">
            <ActivityIndicator size="small" color="#a78bfa" />
            <Text style={styles.cardHeading}>Loading</Text>
            <Text style={styles.cardBody}>{viewState.message}</Text>
          </View>
        ) : null}

        {viewState.status === 'error' ? (
          <View style={styles.errorCard} testID="sessions-error-card">
            <Text style={styles.errorCardHeading}>
              {errorHeadingForKind(viewState.error.kind)}
            </Text>
            <Text style={styles.errorCardBody} testID="sessions-error-message">
              {viewState.error.message}
            </Text>
            {viewState.error.kind === 'auth_rejected' ? (
              <Pressable
                testID="sessions-error-settings-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={onOpenSettings}>
                <Text style={styles.primaryButtonText}>
                  Open Settings to Replace Key
                </Text>
              </Pressable>
            ) : (
              <Pressable
                testID="sessions-error-retry-button"
                accessibilityRole="button"
                style={styles.primaryButton}
                onPress={handleManualRefresh}>
                <Text style={styles.primaryButtonText}>Retry</Text>
              </Pressable>
            )}
          </View>
        ) : null}

        {activeSnapshot && tree ? (
          <>
            <View style={styles.filterBar} testID="sessions-filter-bar">
              {SESSION_FILTER_OPTIONS.map(option => {
                const selected = option.key === activeFilter;
                return (
                  <Pressable
                    key={option.key}
                    testID={`sessions-filter-${option.key}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[
                      styles.filterChip,
                      selected && styles.filterChipSelected,
                    ]}
                    onPress={() => setActiveFilter(option.key)}>
                    <Text
                      style={[
                        styles.filterChipText,
                        selected && styles.filterChipTextSelected,
                      ]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {tree.totalLoadedCount === 0 ? (
              isStale ? (
                <View style={styles.card} testID="sessions-stale-empty-card">
                  <Text style={styles.cardHeading}>
                    0 sessions (last known · not live)
                  </Text>
                  <Text style={styles.cardBody}>
                    The previous sync reported 0 sessions. Current sessions are
                    unknown while live refresh is unavailable.
                  </Text>
                </View>
              ) : (
                <View style={styles.card} testID="sessions-empty-card">
                  <Text style={styles.cardHeading}>0 sessions</Text>
                  <Text style={styles.cardBody}>
                    No sessions are currently reported by this Spawnea server.
                  </Text>
                </View>
              )
            ) : tree.rootSessions.length === 0 ? (
              <View style={styles.card} testID="sessions-filter-empty-card">
                <Text style={styles.cardHeading}>
                  No {activeFilterLabel} sessions
                </Text>
                <Text style={styles.cardBody}>
                  None of the {tree.totalLoadedCount} loaded sessions match this
                  filter.
                </Text>
                <Pressable
                  testID="sessions-filter-reset-button"
                  accessibilityRole="button"
                  style={styles.secondaryButton}
                  onPress={() => setActiveFilter('all')}>
                  <Text style={styles.secondaryButtonText}>
                    Show all sessions
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.sessionList} testID="sessions-list">
                {tree.rootSessions.map(session => {
                  const parentTitle = session.parentSessionId
                    ? tree.parentTitleById.get(session.parentSessionId)
                    : undefined;
                  return (
                    <SessionListCard
                      key={session.id}
                      session={session}
                      childrenByParentId={tree.childrenByParentId}
                      needsInputDescendantCounts={tree.needsInputDescendantCounts}
                      expandedOverrides={expandedOverrides}
                      parentTitle={parentTitle}
                      activityNowMs={activityNowMs}
                      onToggleChildren={handleToggleChildren}
                      onPress={handleOpenSession}
                    />
                  );
                })}
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SessionMetadataRow({
  session,
  parentTitle,
  activityNowMs,
  iconSize,
}: {
  session: SessionSummary;
  parentTitle?: string;
  activityNowMs: number;
  iconSize: number;
}): React.JSX.Element {
  const projectLabel = formatProjectName(session);
  const hostLabel = formatHostName(session);
  const harnessIdentity = formatHarnessIdentity(session);
  const branchLabel = session.worktree?.branch?.trim() || null;
  const relativeActivity = formatRelativeActivity(
    session.lastActivityAt,
    activityNowMs,
  );

  return (
    <View style={styles.metaRow}>
      <View
        style={styles.metaItem}
        accessible
        accessibilityLabel={`Project: ${projectLabel}`}>
        <ProjectIcon color="#93c5fd" size={iconSize} />
        <Text style={styles.metaText}>{projectLabel}</Text>
      </View>

      <View
        style={styles.metaItem}
        accessible
        accessibilityLabel={`Host: ${hostLabel}`}>
        <HostIcon color="#8b949e" size={iconSize} hostName={hostLabel} />
        <Text style={styles.metaText}>{hostLabel}</Text>
      </View>

      <View
        style={styles.metaItem}
        accessible
        accessibilityLabel={harnessIdentity.accessibilityLabel}>
        <HarnessIcon
          color="#a78bfa"
          size={iconSize}
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
          <BranchIcon color="#93c5fd" size={iconSize} />
          <Text style={styles.metaBranchText}>{branchLabel}</Text>
        </View>
      ) : null}

      <View
        style={styles.metaItem}
        accessible
        accessibilityLabel={`Last activity: ${relativeActivity}`}>
        <ActivityIcon color="#8b949e" size={iconSize} />
        <Text style={styles.metaText}>{relativeActivity}</Text>
      </View>

      {parentTitle ? (
        <View
          style={styles.metaItem}
          accessible
          accessibilityLabel={`Parent session: ${parentTitle}`}>
          <ChildrenIcon color="#c4b5fd" size={iconSize} />
          <Text style={styles.metaText}>Parent: {parentTitle}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SessionChildrenSection({
  parentId,
  childrenSessions,
  childrenByParentId,
  needsInputDescendantCounts,
  expandedOverrides,
  activityNowMs,
  onToggleChildren,
  onPress,
  visitedIds,
  nested = false,
}: {
  parentId: string;
  childrenSessions: SessionSummary[];
  childrenByParentId: Map<string, SessionSummary[]>;
  needsInputDescendantCounts: Map<string, number>;
  expandedOverrides: Record<string, boolean>;
  activityNowMs: number;
  onToggleChildren: (parentId: string, currentExpanded: boolean) => void;
  onPress: (sessionId: string) => void;
  visitedIds: Set<string>;
  nested?: boolean;
}): React.JSX.Element | null {
  if (childrenSessions.length === 0) {
    return null;
  }

  const pendingDescendantCount = needsInputDescendantCounts.get(parentId) ?? 0;
  const hasNeedsInputDescendant = pendingDescendantCount > 0;
  const isExpanded = expandedOverrides[parentId] ?? hasNeedsInputDescendant;
  const { visibleLabel, accessibilityLabel } = formatChildrenToggleLabels(
    childrenSessions.length,
    isExpanded,
    pendingDescendantCount,
  );
  const chipIconColor = hasNeedsInputDescendant ? '#fde68a' : '#c4b5fd';

  return (
    <View
      style={nested ? styles.nestedChildrenFooter : styles.childrenFooter}>
      <Pressable
        testID={`sessions-children-toggle-${parentId}`}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.childrenChip,
          hasNeedsInputDescendant && styles.childrenChipNeedsInput,
        ]}
        onPress={() => onToggleChildren(parentId, isExpanded)}>
        <ChildrenIcon color={chipIconColor} size={nested ? 11 : 12} />
        <Text
          style={[
            styles.childrenChipText,
            hasNeedsInputDescendant && styles.childrenChipTextNeedsInput,
          ]}>
          {visibleLabel}
        </Text>
        <ChevronIcon
          direction={isExpanded ? 'up' : 'down'}
          color={chipIconColor}
          size={7}
        />
      </Pressable>

      {isExpanded ? (
        <View
          style={styles.childrenList}
          testID={`sessions-children-list-${parentId}`}>
          {childrenSessions.map(child => (
            <SessionChildBranch
              key={child.id}
              child={child}
              childrenByParentId={childrenByParentId}
              needsInputDescendantCounts={needsInputDescendantCounts}
              expandedOverrides={expandedOverrides}
              activityNowMs={activityNowMs}
              onToggleChildren={onToggleChildren}
              onPress={onPress}
              visitedIds={visitedIds}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SessionChildBranch({
  child,
  childrenByParentId,
  needsInputDescendantCounts,
  expandedOverrides,
  activityNowMs,
  onToggleChildren,
  onPress,
  visitedIds,
}: {
  child: SessionSummary;
  childrenByParentId: Map<string, SessionSummary[]>;
  needsInputDescendantCounts: Map<string, number>;
  expandedOverrides: Record<string, boolean>;
  activityNowMs: number;
  onToggleChildren: (parentId: string, currentExpanded: boolean) => void;
  onPress: (sessionId: string) => void;
  visitedIds: Set<string>;
}): React.JSX.Element | null {
  if (visitedIds.has(child.id)) {
    return null;
  }
  const nextVisited = new Set(visitedIds);
  nextVisited.add(child.id);

  const childTitle = formatSessionTitle(child);
  const trimmedTask = child.task.trim();
  const showTaskSubtitle = trimmedTask.length > 0 && trimmedTask !== childTitle;
  const isChildNeedsInput = child.status === 'needs_input';
  const grandchildren = childrenByParentId.get(child.id) ?? [];

  return (
    <View
      style={[
        styles.childRow,
        isChildNeedsInput && styles.childRowNeedsInput,
      ]}>
      <Pressable
        testID={`sessions-child-card-${child.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${childTitle}, ${formatSessionStatusLabel(child.status)}`}
        style={styles.childPressable}
        onPress={() => onPress(child.id)}>
        <View style={styles.childRowHeader}>
          <Text style={styles.childTitle} numberOfLines={2}>
            {childTitle}
          </Text>
          <View style={styles.sessionHeaderRight}>
            <StatusChip status={child.status} />
            <ChevronIcon direction="right" color="#6e7681" size={7} />
          </View>
        </View>

        {showTaskSubtitle ? (
          <Text style={styles.childTask} numberOfLines={2}>
            {trimmedTask}
          </Text>
        ) : null}

        <SessionMetadataRow
          session={child}
          activityNowMs={activityNowMs}
          iconSize={11}
        />
      </Pressable>

      <SessionChildrenSection
        parentId={child.id}
        childrenSessions={grandchildren}
        childrenByParentId={childrenByParentId}
        needsInputDescendantCounts={needsInputDescendantCounts}
        expandedOverrides={expandedOverrides}
        activityNowMs={activityNowMs}
        onToggleChildren={onToggleChildren}
        onPress={onPress}
        visitedIds={nextVisited}
        nested
      />
    </View>
  );
}

function SessionListCard({
  session,
  childrenByParentId,
  needsInputDescendantCounts,
  expandedOverrides,
  parentTitle,
  activityNowMs,
  onToggleChildren,
  onPress,
}: {
  session: SessionSummary;
  childrenByParentId: Map<string, SessionSummary[]>;
  needsInputDescendantCounts: Map<string, number>;
  expandedOverrides: Record<string, boolean>;
  parentTitle?: string;
  activityNowMs: number;
  onToggleChildren: (parentId: string, currentExpanded: boolean) => void;
  onPress: (sessionId: string) => void;
}): React.JSX.Element {
  const title = formatSessionTitle(session);
  const trimmedTask = session.task.trim();
  const showTaskSubtitle = trimmedTask.length > 0 && trimmedTask !== title;
  const isNeedsInput = session.status === 'needs_input';
  const childrenSessions = childrenByParentId.get(session.id) ?? [];
  const visitedIds = new Set<string>([session.id]);

  return (
    <View
      style={[
        styles.sessionCardWrapper,
        isNeedsInput && styles.sessionCardWrapperNeedsInput,
      ]}>
      <Pressable
        testID={`sessions-card-${session.id}`}
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

        <SessionMetadataRow
          session={session}
          parentTitle={parentTitle}
          activityNowMs={activityNowMs}
          iconSize={12}
        />
      </Pressable>

      <SessionChildrenSection
        parentId={session.id}
        childrenSessions={childrenSessions}
        childrenByParentId={childrenByParentId}
        needsInputDescendantCounts={needsInputDescendantCounts}
        expandedOverrides={expandedOverrides}
        activityNowMs={activityNowMs}
        onToggleChildren={onToggleChildren}
        onPress={onPress}
        visitedIds={visitedIds}
      />
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
    gap: 8,
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
  headerSummaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
  },
  headerMetaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  headerMetaText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  headerNeedsInputBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderWidth: 1,
    borderColor: '#d97706',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  headerNeedsInputDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#fbbf24',
  },
  headerNeedsInputText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fde68a',
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
  filterBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  filterChip: {
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  filterChipSelected: {
    backgroundColor: 'rgba(139, 92, 246, 0.22)',
    borderColor: '#a78bfa',
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9ca3af',
  },
  filterChipTextSelected: {
    color: '#f0f6fc',
    fontWeight: '700',
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
  nestedChildrenFooter: {
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    paddingTop: 8,
    gap: 8,
  },
  childrenChip: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
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
  childrenChipNeedsInput: {
    backgroundColor: 'rgba(245, 158, 11, 0.16)',
    borderColor: '#d97706',
  },
  childrenChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ddd6fe',
    flexShrink: 1,
  },
  childrenChipTextNeedsInput: {
    color: '#fde68a',
  },
  childrenList: {
    borderLeftWidth: 2,
    borderLeftColor: '#6d28d9',
    paddingLeft: 10,
    gap: 8,
  },
  childRow: {
    backgroundColor: '#0d1117',
    borderWidth: 1,
    borderColor: '#21262d',
    borderRadius: 8,
    padding: 9,
    gap: 8,
  },
  childRowNeedsInput: {
    backgroundColor: '#181b22',
    borderColor: '#d97706',
    borderWidth: 1.5,
  },
  childPressable: {
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
  childTask: {
    fontSize: 12,
    color: '#9ca3af',
    lineHeight: 17,
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
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#161b22',
    borderWidth: 1,
    borderColor: '#30363d',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  secondaryButtonText: {
    color: '#f0f6fc',
    fontSize: 13,
    fontWeight: '600',
  },
});
