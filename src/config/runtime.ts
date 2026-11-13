import { NativeModules } from 'react-native';

interface NativeSpawneaHttpConstants {
  allowDebugLoopback?: boolean;
  getConstants?: () => { allowDebugLoopback?: boolean };
}

/**
 * Determines whether debug-only loopback HTTP is permitted.
 * Prefers the native BuildConfig.DEBUG flag exposed by SpawneaHttp so bundled
 * debug APKs (which compile JS with devEnabled=false) still retain debug
 * loopback support while release builds remain strictly HTTPS-only.
 */
export function isDebugLoopbackAllowed(): boolean {
  const nativeHttp = (
    NativeModules as { SpawneaHttp?: NativeSpawneaHttpConstants }
  ).SpawneaHttp;

  const fromConstants = nativeHttp?.getConstants?.().allowDebugLoopback;
  if (typeof fromConstants === 'boolean') {
    return fromConstants;
  }
  if (typeof nativeHttp?.allowDebugLoopback === 'boolean') {
    return nativeHttp.allowDebugLoopback;
  }
  return __DEV__;
}
