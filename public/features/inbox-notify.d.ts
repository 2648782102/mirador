// Types for public/features/inbox-notify.js, for the TypeScript that imports it (its tests). The
// browser never loads this file: no page or module imports it, and the bundle (src/http/bundle.ts)
// follows imports from public/'s entry points only.

/** The fields of an inbox item the notifier reads; the stream sends more, which it passes through. */
export interface InboxNotifyItem {
  terminalId: unknown;
  since: unknown;
  /** 'finished' (a turn waiting for review) never notifies; any other kind does. */
  kind?: unknown;
  detail?: unknown;
}

export type InboxNotifyStatus = 'unsupported' | 'denied' | 'on' | 'off';

/** The prefs key (localStorage `mirador.inboxNotify`). */
export const NOTIFY_PREF: 'inboxNotify';

/** One waiting episode: the terminal and when it started waiting. */
export function episodeKey(item: InboxNotifyItem): string;

/** The browser's Notification class as the notifier uses it, or a test's stand-in. */
export interface NotificationApiLike {
  permission: string;
  requestPermission(callback?: (permission: string) => void): unknown;
}

export interface InboxNotifier {
  status(): InboxNotifyStatus;
  /** From a click only: asks for the permission when needed; resolves to the new status. */
  toggle(): Promise<InboxNotifyStatus>;
  /** Called with each stream message's items; returns the ones it notified. */
  receive<T>(items: readonly T[], skip?: (item: T) => boolean): T[];
}

/**
 * The notifier behind the inbox's notification button. `show(item)` returns the notification
 * (one with `close()` is closed when its card leaves), or a falsy value when the browser threw.
 */
export function createInboxNotifier(deps: {
  api: NotificationApiLike | null | undefined;
  read: () => unknown;
  write: (value: boolean) => unknown;
  show: (item: any) => unknown;
}): InboxNotifier;

export interface InboxNotificationText {
  title: string;
  options: { body: string; tag: string; requireInteraction: false };
}

/** What one notification says, tagged by its card so a second window replaces it. */
export function notificationFor(item: InboxNotifyItem, text: { reason: string; where: string }): InboxNotificationText;

/** Shows one card's notification with the Notification class `Api` and returns it. */
export function showNotification<N extends object>(
  Api: new (title: string, options: InboxNotificationText['options']) => N,
  item: InboxNotifyItem,
  text: { reason: string; where: string },
  actions: { focus: () => unknown; open: (item: any) => unknown },
): N;
