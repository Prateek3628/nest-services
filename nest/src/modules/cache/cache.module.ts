import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { SessionCache } from './session.cache';
import { AudioDedupCache } from './audio-dedup.cache';
import { ExactResponseCache } from './exact-response.cache';
import { SttRawCache } from './stt-raw.cache';
import { TtsRelayCache } from './tts-relay.cache';

@Module({
  imports: [RedisModule],
  providers: [
    SessionCache,
    AudioDedupCache,
    ExactResponseCache,
    SttRawCache,
    TtsRelayCache,
  ],
  exports: [
    SessionCache,
    AudioDedupCache,
    ExactResponseCache,
    SttRawCache,
    TtsRelayCache,
  ],
})
export class CacheModule {}
