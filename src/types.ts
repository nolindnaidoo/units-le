import type { Dimension } from './extract';

export type NotificationLevel = 'all' | 'important' | 'silent';

/** The extension's settings, read once per command and frozen. */
export interface Configuration {
	readonly copyToClipboardEnabled: boolean;
	readonly dimensions: readonly Dimension[];
	readonly notificationsLevel: NotificationLevel;
	readonly openResultsSideBySide: boolean;
	readonly safetyEnabled: boolean;
	readonly safetyFileSizeWarnBytes: number;
	readonly statusBarEnabled: boolean;
	readonly telemetryEnabled: boolean;
}
