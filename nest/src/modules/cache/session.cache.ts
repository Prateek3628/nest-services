import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class SessionCache {
  constructor(@Inject('REDIS') private redis: Redis) {}

  private key(sessionId: string) {
    return `session:${sessionId}`;
  }

  async get(sessionId: string) {
    const data = await this.redis.get(this.key(sessionId));
    return data ? JSON.parse(data) : null;
  }

  async set(sessionId: string, payload: any) {
    await this.redis.set(
      this.key(sessionId),
      JSON.stringify(payload),
      'EX',
      1800, // 30 min TTL (conversation lifetime)
    );
  }
}
