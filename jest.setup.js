/* eslint-env jest */
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    },
  };
});

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async key => (store.has(key) ? store.get(key) : null)),
      setItem: jest.fn(async (key, value) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async key => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
      __store: store,
    },
  };
});

const { NativeModules } = require('react-native');

NativeModules.SpawneaKeystore = {
  getCapability: jest.fn(async () => ({
    biometryAvailable: true,
    biometryType: 'Fingerprint',
    status: 'available',
  })),
  getCredentialState: jest.fn(async () => ({
    serverUrl: null,
    hasKey: false,
    incomplete: false,
  })),
  hasKey: jest.fn(async () => false),
  saveCredentials: jest.fn(async () => true),
  updateServerUrl: jest.fn(async () => true),
  readKey: jest.fn(async () => ''),
  deleteKey: jest.fn(async () => true),
};

jest.mock('react-native-screens', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    enableScreens: jest.fn(),
    screensEnabled: jest.fn(() => false),
    compatibilityFlags: {},
    featureFlags: { experiment: {} },
    Screen: ({ children, ...props }) => React.createElement(View, props, children),
    ScreenContainer: ({ children, ...props }) =>
      React.createElement(View, props, children),
    ScreenStack: ({ children, ...props }) =>
      React.createElement(View, props, children),
    ScreenStackItem: ({ children, ...props }) =>
      React.createElement(View, props, children),
    ScreenStackHeaderConfig: () => null,
    ScreenStackHeaderSubview: () => null,
    ScreenStackHeaderLeftView: () => null,
    ScreenStackHeaderRightView: () => null,
    ScreenStackHeaderTitleView: () => null,
    ScreenStackHeaderCenterView: () => null,
    SearchBar: () => null,
    FullWindowOverlay: ({ children }) => children,
  };
});
