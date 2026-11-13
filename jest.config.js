module.exports = {
  preset: '@react-native/jest-preset',
  haste: {
    defaultPlatform: 'android',
    platforms: ['android', 'native'],
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-screens|react-native-safe-area-context|react-native-keychain|@react-native-async-storage/async-storage)/)',
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
