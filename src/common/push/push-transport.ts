import { Injectable } from '@nestjs/common';
import webPush, { type PushSubscription } from 'web-push';
import { webPushConfig } from './web-push.config';
import { validateSubscription } from './push-subscription';
@Injectable()
export class PushTransport {
  constructor() {
    webPushConfig();
  }
  async send(subscription: PushSubscription, payload: object) {
    const config = webPushConfig();
    if (!config) throw new Error('Web Push is not configured');
    validateSubscription(subscription);
    // web-push uses https.request directly, does not follow redirects.
    await webPush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
      TTL: 300,
      urgency: 'normal',
      timeout: 10_000,
    });
  }
}
