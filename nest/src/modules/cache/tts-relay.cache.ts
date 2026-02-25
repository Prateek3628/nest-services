import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class TtsRelayCache {
  constructor(@Inject('REDIS') private redis: Redis) {}

  private key(responseId: string) {
    return `tts_relay:${responseId}`;
  }

  async get(responseId: string): Promise<Buffer | null> {
    const data = await this.redis.getBuffer(this.key(responseId));
    return data ?? null;
  }

  async set(responseId: string, audio: Buffer) {
    await this.redis.set(
      this.key(responseId),
      audio,
      'EX',
      300, // 5 min – UX cache only
    );
  }
}
