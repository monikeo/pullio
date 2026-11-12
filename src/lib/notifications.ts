export type NotificationAccess = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationAccess(): NotificationAccess {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationAccess(): Promise<NotificationAccess> {
  if (notificationAccess() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return notificationAccess();
  }
}

/**
 * Show a system notification while Pullio is in the background. In the foreground the in-app
 * transfer cards already show the result, so nothing is shown.
 */
export function notifyInBackground(title: string, body: string, tag?: string) {
  if (notificationAccess() !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  const options: NotificationOptions = { body: body.slice(0, 180), tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: '/?tab=transfers' } };
  const fallback = () => { try { new Notification(title, options); } catch {} };
  // Android Chrome only allows notifications through the service worker registration.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration()
      .then((registration) => registration ? registration.showNotification(title, options) : fallback())
      .catch(fallback);
  } else {
    fallback();
  }
}
