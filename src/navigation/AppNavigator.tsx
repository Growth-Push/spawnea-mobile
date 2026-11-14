import React from 'react';
import { StyleSheet, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  NavigationContainer,
  type NavigatorScreenParams,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { DashboardScreen } from '../screens/DashboardScreen';
import { SessionChatScreen } from '../screens/SessionChatScreen';
import { SessionsScreen } from '../screens/SessionsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

export type SessionsStackParamList = {
  SessionsList: undefined;
  SessionChat: { sessionId?: string } | undefined;
};

export type RootTabParamList = {
  DashboardTab: undefined;
  SessionsTab: NavigatorScreenParams<SessionsStackParamList> | undefined;
  SettingsTab: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();
const SessionsStack = createNativeStackNavigator<SessionsStackParamList>();

function DashboardTabIcon({
  color,
  size,
}: {
  color: string;
  size: number;
}): React.JSX.Element {
  const tile = Math.max(6, Math.floor((size - 6) / 2));
  return (
    <View style={[iconStyles.grid, { width: size, height: size }]}>
      <View
        style={[
          iconStyles.tile,
          { width: tile, height: tile, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.tile,
          { width: tile, height: tile, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.tile,
          { width: tile, height: tile, backgroundColor: color },
        ]}
      />
      <View
        style={[
          iconStyles.tile,
          { width: tile, height: tile, backgroundColor: color },
        ]}
      />
    </View>
  );
}

function SessionsTabIcon({
  color,
  size,
}: {
  color: string;
  size: number;
}): React.JSX.Element {
  const barWidth = Math.max(12, size - 4);
  return (
    <View style={[iconStyles.stack, { width: size, height: size }]}>
      <View
        style={[iconStyles.bar, { width: barWidth, backgroundColor: color }]}
      />
      <View
        style={[
          iconStyles.bar,
          { width: Math.max(8, barWidth - 4), backgroundColor: color },
        ]}
      />
      <View
        style={[iconStyles.bar, { width: barWidth, backgroundColor: color }]}
      />
    </View>
  );
}

function SettingsTabIcon({
  color,
  size,
}: {
  color: string;
  size: number;
}): React.JSX.Element {
  const trackWidth = Math.max(14, size - 4);
  return (
    <View style={[iconStyles.stack, { width: size, height: size }]}>
      <View style={[iconStyles.sliderRow, { width: trackWidth }]}>
        <View style={[iconStyles.track, { backgroundColor: color }]} />
        <View
          style={[iconStyles.knob, iconStyles.knobLeft, { backgroundColor: color }]}
        />
      </View>
      <View style={[iconStyles.sliderRow, { width: trackWidth }]}>
        <View style={[iconStyles.track, { backgroundColor: color }]} />
        <View
          style={[iconStyles.knob, iconStyles.knobRight, { backgroundColor: color }]}
        />
      </View>
      <View style={[iconStyles.sliderRow, { width: trackWidth }]}>
        <View style={[iconStyles.track, { backgroundColor: color }]} />
        <View
          style={[iconStyles.knob, iconStyles.knobCenter, { backgroundColor: color }]}
        />
      </View>
    </View>
  );
}

function renderDashboardTabIcon({
  color,
  size,
}: {
  color: string;
  size: number;
}): React.JSX.Element {
  return <DashboardTabIcon color={color} size={size} />;
}

function renderSessionsTabIcon({
  color,
  size,
}: {
  color: string;
  size: number;
}): React.JSX.Element {
  return <SessionsTabIcon color={color} size={size} />;
}

function renderSettingsTabIcon({
  color,
  size,
}: {
  color: string;
  size: number;
}): React.JSX.Element {
  return <SettingsTabIcon color={color} size={size} />;
}

function SessionsStackNavigator({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}): React.JSX.Element {
  return (
    <SessionsStack.Navigator>
      <SessionsStack.Screen
        name="SessionsList"
        options={{ title: 'Sessions', headerShown: false }}>
        {({ navigation }) => (
          <SessionsScreen
            onOpenSessionChat={sessionId =>
              navigation.navigate('SessionChat', { sessionId })
            }
            onOpenSettings={onOpenSettings}
          />
        )}
      </SessionsStack.Screen>
      <SessionsStack.Screen
        name="SessionChat"
        component={SessionChatScreen}
        options={{ title: 'Session / Chat' }}
      />
    </SessionsStack.Navigator>
  );
}

export function AppNavigator(): React.JSX.Element {
  return (
    <NavigationContainer>
      <Tab.Navigator
        initialRouteName="DashboardTab"
        screenOptions={{
          headerTitleAlign: 'left',
          tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        }}>
        <Tab.Screen
          name="DashboardTab"
          options={{
            title: 'Dashboard',
            tabBarLabel: 'Dashboard',
            headerShown: false,
            tabBarStyle: {
              backgroundColor: '#0d1117',
              borderTopColor: '#21262d',
            },
            tabBarActiveTintColor: '#a78bfa',
            tabBarInactiveTintColor: '#8b949e',
            tabBarIcon: renderDashboardTabIcon,
          }}>
          {({
            navigation,
          }: {
            navigation: BottomTabNavigationProp<RootTabParamList, 'DashboardTab'>;
          }) => (
            <DashboardScreen
              onOpenSettings={() => navigation.navigate('SettingsTab')}
              onOpenSessions={() =>
                navigation.navigate('SessionsTab', {
                  screen: 'SessionsList',
                })
              }
              onOpenSessionChat={sessionId =>
                navigation.navigate('SessionsTab', {
                  screen: 'SessionChat',
                  params: { sessionId },
                  initial: false,
                })
              }
            />
          )}
        </Tab.Screen>

        <Tab.Screen
          name="SessionsTab"
          options={{
            title: 'Sessions',
            tabBarLabel: 'Sessions',
            tabBarButtonTestID: 'sessions-tab-button',
            headerShown: false,
            tabBarStyle: {
              backgroundColor: '#0d1117',
              borderTopColor: '#21262d',
            },
            tabBarActiveTintColor: '#a78bfa',
            tabBarInactiveTintColor: '#8b949e',
            tabBarIcon: renderSessionsTabIcon,
          }}>
          {({
            navigation,
          }: {
            navigation: BottomTabNavigationProp<RootTabParamList, 'SessionsTab'>;
          }) => (
            <SessionsStackNavigator
              onOpenSettings={() => navigation.navigate('SettingsTab')}
            />
          )}
        </Tab.Screen>

        <Tab.Screen
          name="SettingsTab"
          component={SettingsScreen}
          options={{
            title: 'Settings',
            tabBarLabel: 'Settings',
            tabBarIcon: renderSettingsTabIcon,
          }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const iconStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignContent: 'space-between',
    padding: 2,
  },
  tile: {
    borderRadius: 2,
  },
  stack: {
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingVertical: 2,
  },
  bar: {
    height: 3,
    borderRadius: 1.5,
  },
  sliderRow: {
    height: 6,
    justifyContent: 'center',
  },
  track: {
    height: 2,
    width: '100%',
    borderRadius: 1,
  },
  knob: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  knobLeft: {
    left: 2,
  },
  knobCenter: {
    left: '40%',
  },
  knobRight: {
    right: 2,
  },
});
