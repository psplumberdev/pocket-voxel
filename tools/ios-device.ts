import { IPODTOUCH4_DEVICE, IPODTOUCH4_DEPLOYMENT, ipodtouch4CacheRoot } from '../vendor/pocketjs/tools/ipodtouch4-toolchain.ts';
import { IPHONE4S_TOOLCHAIN, iphone4sCacheRoot } from '../vendor/pocketjs/tools/iphone4s-toolchain.ts';

export function legacyIosDevice(name = 'iphone4s', env: NodeJS.ProcessEnv = process.env) {
  if (name !== 'iphone4s' && name !== 'ipodtouch4') throw new Error(`unsupported iOS device: ${name}`);
  const userApp = name === 'ipodtouch4';
  const prefix = userApp ? 'POCKETJS_IPODTOUCH4' : 'POCKETJS_IPHONE4S';
  return {
    name, userApp, prefix,
    cacheRoot: userApp ? ipodtouch4CacheRoot(env) : iphone4sCacheRoot(env),
    deployment: userApp ? IPODTOUCH4_DEPLOYMENT : IPHONE4S_TOOLCHAIN.deployment,
    identity: userApp
      ? [IPODTOUCH4_DEVICE.productType, IPODTOUCH4_DEVICE.hardwareModel, IPODTOUCH4_DEVICE.productVersion, IPODTOUCH4_DEVICE.buildVersion, 'Activated']
      : ['iPhone4,1', 'N94AP', '6.1.3', '10B329', 'Activated'],
  };
}

export function assertLegacyIosIdentity(expected: readonly string[], actual: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`refusing device ${actual.join('/')} (expected ${expected.join('/')})`);
  }
}
