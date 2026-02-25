import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class ExactResponseCache {
  constructor(@Inject('REDIS') private redis: Redis) {}

  private key(lang: string, text: string) {
    return `exact_response:${lang}:${text}`;
  }

  async get(lang: string, text: string) {
    const data = await this.redis.get(this.key(lang, text));
    return data ? JSON.parse(data) : null;
  }

  async set(lang: string, text: string, response: any) {
    await this.redis.set(
      this.key(lang, text),
      JSON.stringify(response),
      'EX',
      60, // short TTL – Python semantic cache does long-term reuse
    );
  }
}
