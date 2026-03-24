/**
 * Web Push notification support for the mobile PWA.
 *
 * VAPID keys are generated once and stored in the data directory.
 * Push notifications are sent on chat.message.received events.
 */
import fs from 'fs';
import path from 'path';
import webpush from 'web-push';
import { STORE_DIR } from './config.js';
import {
  getAllPushSubscriptions,
  deletePushSubscription,
  getAgentById,
} from './db.js';
import { logger } from './logger.js';

const VAPID_KEYS_PATH = path.join(STORE_DIR, 'vapid-keys.json');

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let vapidKeys: VapidKeys | null = null;

export function initWebPush(): void {
  // Load or generate VAPID keys
  if (fs.existsSync(VAPID_KEYS_PATH)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf-8')) as VapidKeys;
  } else {
    const keys = webpush.generateVAPIDKeys();
    vapidKeys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    fs.mkdirSync(path.dirname(VAPID_KEYS_PATH), { recursive: true });
    fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
    logger.info('Generated new VAPID keys');
  }

  webpush.setVapidDetails(
    'mailto:ceo@octopus.local',
    vapidKeys.publicKey,
    vapidKeys.privateKey,
  );
}

export function getVapidPublicKey(): string {
  return vapidKeys?.publicKey ?? '';
}

export async function sendPushNotification(
  agentId: string,
  agentName: string,
  content: string,
): Promise<void> {
  const subscriptions = getAllPushSubscriptions();
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: agentName,
    body: content.length > 200 ? content.slice(0, 200) + '...' : content,
    data: { agentId },
    tag: `chat-${agentId}`,
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth,
          },
        },
        payload,
      );
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        // Subscription expired or unsubscribed — clean up
        deletePushSubscription(sub.endpoint);
        logger.info({ endpoint: sub.endpoint }, 'Removed expired push subscription');
      } else {
        logger.warn({ err, endpoint: sub.endpoint }, 'Push notification failed');
      }
    }
  }
}
