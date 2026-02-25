import { Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module';
import { TtsModule } from '../tts/tts.module';
import { PythonModule } from '../python/python.module';
import { VoiceGateway } from './voice.gateway';

@Module({
  imports: [CacheModule, TtsModule, PythonModule],
  providers: [VoiceGateway],
})
export class VoiceModule {}
