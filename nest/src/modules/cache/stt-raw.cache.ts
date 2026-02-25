import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class SttRawCache {
  constructor(@Inject('REDIS') private redis: Redis) {}

  private key(audioHash: string) {
    return `stt_raw:${audioHash}`;
  }

  async get(audioHash: string): Promise<string | null> {
    return this.redis.get(this.key(audioHash));
  }

  async set(audioHash: string, transcript: string) {
    await this.redis.set(
      this.key(audioHash),
      transcript,
      'EX',
      300, // 5 minutes – retry window
    );
  }
}
