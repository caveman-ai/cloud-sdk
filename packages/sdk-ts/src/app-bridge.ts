/**
 * Browser-safe capability bridge client for isolated tenant Apps (`capp_...`).
 *
 * Import from `@caveman-ai/sdk/app-bridge` inside an App iframe so the bundle
 * stays minimal and carries only the bridge transport.
 */
export {
  AppBridge,
  PlatformError,
  type AppKind,
  type AppManifest,
  type AppScope,
  type AppTokenIssued,
  type PlatformClientOptions,
  type RoomMessage,
  type TenantApp,
} from './platform2027.js';
