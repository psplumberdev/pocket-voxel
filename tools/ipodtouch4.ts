export {};
process.env.POCKETVOXEL_IOS_DEVICE = 'ipodtouch4';
const { main } = await import('./iphone4s.ts');
await main();
