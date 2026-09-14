import { expect, test } from 'bun:test';
import { assertLegacyIosIdentity, legacyIosDevice } from '../tools/ios-device.ts';

test('legacy iOS targets keep device identity and SSH material separate', () => {
  const iphone = legacyIosDevice();
  const ipod = legacyIosDevice('ipodtouch4');
  expect(iphone.name).toBe('iphone4s');
  expect(iphone.userApp).toBe(false);
  expect(ipod.userApp).toBe(true);
  expect(ipod.prefix).toBe('POCKETJS_IPODTOUCH4');
  expect(ipod.cacheRoot).not.toBe(iphone.cacheRoot);
  expect(ipod.deployment.localPort).not.toBe(iphone.deployment.localPort);
  expect(() => assertLegacyIosIdentity(ipod.identity, ipod.identity)).not.toThrow();
  expect(() => assertLegacyIosIdentity(iphone.identity, iphone.identity)).not.toThrow();
  expect(() => assertLegacyIosIdentity(iphone.identity, ipod.identity)).toThrow('refusing device');
  expect(() => assertLegacyIosIdentity(ipod.identity, iphone.identity)).toThrow('refusing device');
});

test('unvalidated firmware and device selections fail closed', () => {
  const ipod = legacyIosDevice('ipodtouch4');
  for (const identity of [[], ['iPod5,1', ...ipod.identity.slice(1)], [...ipod.identity.slice(0, 4), 'Unactivated']]) {
    expect(() => assertLegacyIosIdentity(ipod.identity, identity)).toThrow('refusing device');
  }
  expect(() => legacyIosDevice('iphone16')).toThrow('unsupported iOS device');
});
