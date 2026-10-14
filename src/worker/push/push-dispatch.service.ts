import { Injectable } from '@nestjs/common';
import { PushTransport } from '../../common/push/push-transport';
import { decryptSubscription } from '../../common/push/push-subscription';
import { webPushConfig } from '../../common/push/web-push.config';
import { PushDispatchRepository } from './push-dispatch.repository';
@Injectable()
export class PushDispatchService {
  constructor(
    private readonly repository: PushDispatchRepository,
    private readonly transport: PushTransport
  ) {}
  async runBatch(limit = 20) {
    const config = webPushConfig();
    const result = {
      expanded: 0,
      sent: 0,
      held: 0,
      suppressed: 0,
      retried: 0,
      failed: 0,
    };
    if (!config) return result;
    for (let index = 0; index < limit; index++) {
      if (!(await this.repository.fanOutOne())) break;
      result.expanded++;
    }
    for (let index = 0; index < limit; index++) {
      const job = await this.repository.claim();
      if (!job) break;
      const current = await this.repository.eligibility(job.id);
      if (!current || current.decision.action === 'suppress') {
        await this.repository.finish(
          job,
          current?.decision.reason ?? 'not-eligible'
        );
        result.suppressed++;
        continue;
      }
      if (current.decision.action === 'hold') {
        await this.repository.finish(job, 'quiet-hours', {
          retryAfterMs: 60_000,
        });
        result.held++;
        continue;
      }
      if (job.attempts >= 5) {
        await this.repository.finish(job, 'attempts-exhausted', {
          failed: true,
        });
        result.failed++;
        continue;
      }
      let subscription;
      try {
        subscription = decryptSubscription(
          current.delivery.installation.endpointCiphertext,
          config.encryptionKey
        );
      } catch {
        await this.repository.finish(job, 'invalid-subscription', {
          failed: true,
        });
        result.failed++;
        continue;
      }
      try {
        // Compare the fence immediately before a bounded 10-second network send.
        if (!(await this.repository.beginSend(job))) continue;
        await this.transport.send(subscription, {
          deliveryId: job.id,
          installationId: job.installationId,
          recipientId: current.delivery.notification.recipientId,
          notificationId: job.notificationId,
        });
        await this.repository.finish(job, 'accepted');
        result.sent++;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.repository.finish(job, 'subscription-expired', {
            revoke: true,
          });
          result.suppressed++;
        } else if (status && status >= 300 && status < 500 && status !== 429) {
          await this.repository.finish(job, `provider-${status}`, {
            failed: true,
          });
          result.failed++;
        } else if (job.attempts + 1 >= 5) {
          await this.repository.finish(job, 'attempts-exhausted', {
            failed: true,
          });
          result.failed++;
        } else {
          await this.repository.finish(job, 'retryable-failure', {
            retryAfterMs:
              Math.min(3600, 30 * 2 ** job.attempts) * 1000 +
              Math.floor(Math.random() * 5000),
          });
          result.retried++;
        }
      }
    }
    return result;
  }
}
