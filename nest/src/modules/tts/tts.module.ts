import { Module } from '@nestjs/common';
import { PollyService } from './polly.service';
import { ElevenLabsService } from './elevenlabs.service';
import { TtsService } from './tts.service';

@Module({
  providers: [PollyService, ElevenLabsService, TtsService],
  exports: [TtsService],
})
export class TtsModule {}
