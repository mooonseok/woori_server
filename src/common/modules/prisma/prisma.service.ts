import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private instance?: PrismaClient;
  get client(): PrismaClient {
    // A health request or a worker bootstrap must never open a DB connection.
    const url = process.env.DATABASE_URL;
    if (!url)
      throw new ServiceUnavailableException({
        code: 'DATABASE_NOT_CONFIGURED',
      });
    if (!this.instance)
      this.instance = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: url,
          max: 3,
          connectionTimeoutMillis: 5000,
        }),
      });
    return this.instance;
  }
  async onModuleDestroy() {
    await this.instance?.$disconnect();
  }
}
