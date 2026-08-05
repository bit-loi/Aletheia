const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * `src/i18n.ts` imports the locale JSON from `../../shared/locales`, which the
 * extension shares. Metro only resolves files under the project root, so that
 * directory has to be watched explicitly or the bundle fails to resolve it.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '..', 'shared')],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
