import type { Dimension } from './extract';

export type NotificationLevel = 'all' | 'important' | 'silent';

/** The extension's settings, read once per command and frozen. */
export interface Configuration {
	/** Whether the copy on the clipboard carries positions, whatever the screen shows. */
	readonly clipboardIncludesPositions: boolean;
	readonly copyToClipboardEnabled: boolean;
	readonly dimensions: readonly Dimension[];
	readonly notificationsLevel: NotificationLevel;
	readonly openResultsSideBySide: boolean;
	readonly safetyEnabled: boolean;
	readonly safetyFileSizeWarnBytes: number;
	/** Whether the output gives the line and column of each quantity. */
	readonly showPositions: boolean;
	readonly statusBarEnabled: boolean;
	readonly telemetryEnabled: boolean;
}
