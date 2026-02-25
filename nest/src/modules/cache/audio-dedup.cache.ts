import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import xxhash from 'xxhashjs';

@Injectable()
export class AudioDedupCache {
  constructor(@Inject('REDIS') private redis: Redis) {}

  private hash(buffer: Buffer) {
    return xxhash.h32(buffer, 0xabcd).toString(16);
  }

  async isDuplicate(sessionId: string, chunk: Buffer): Promise<boolean> {
    const hash = this.hash(chunk);
    const key = `audio_chunk:${sessionId}:${hash}`;

    const exists = await this.redis.get(key);
    if (exists) return true;

    // very short TTL – only for network retries
    await this.redis.set(key, '1', 'EX', 2);
    return false;
  }
}
