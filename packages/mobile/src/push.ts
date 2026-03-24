const BASE_URL = (import.meta.env.VITE_NANOCLAW_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export async function registerPush(): Promise<void> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push notifications not supported');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;

    // Get VAPID public key from server
    const res = await fetch(`${BASE_URL}/api/v1/push/vapid-key`);
    if (!res.ok) return;
    const { publicKey } = (await res.json()) as { publicKey: string };
    if (!publicKey) return;

    // Check existing subscription
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      // Request permission and subscribe
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });
    }

    // Send subscription to server
    await fetch(`${BASE_URL}/api/v1/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
  } catch (err) {
    console.warn('Push registration failed:', err);
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
