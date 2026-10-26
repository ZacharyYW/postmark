// Imported first by content.ts so these are in place before InboxSDK does anything.
import { exposeExtensionApiOnWindow } from './firefoxCompat';
import { installTelemetryGuard } from './telemetryGuard';

exposeExtensionApiOnWindow();
installTelemetryGuard();
