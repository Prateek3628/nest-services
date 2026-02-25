import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class SessionCache {
  private memory = new Map<string, any>();

  constructor(@Inject('REDIS') private redis: Redis) {}

  private key(sessionId: string) {
    return `session:${sessionId}`;
  }

  async get(sessionId: string) {
    try {
      const data = await this.redis.get(this.key(sessionId));
      return data ? JSON.parse(data) : (this.memory.get(sessionId) ?? null);
    } catch {
      return this.memory.get(sessionId) ?? null;
    }
  }

  async set(sessionId: string, payload: any) {
    this.memory.set(sessionId, payload);
    try {
      await this.redis.set(
        this.key(sessionId),
        JSON.stringify(payload),
        'EX',
        1800,
      );
    } catch {
      // Redis unavailable – in-memory fallback already set above
    }
  }
}
