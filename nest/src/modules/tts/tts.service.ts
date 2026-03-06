import { Injectable, Logger } from '@nestjs/common';
import { PollyService } from './polly.service';
import { ElevenLabsService } from './elevenlabs.service';
import { TtsProvider } from './tts.interface';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private readonly provider: TtsProvider;
  private readonly providerName: string;

  constructor(
    private readonly polly: PollyService,
    private readonly elevenLabs: ElevenLabsService,
  ) {
    // Read TTS_PROVIDER (falls back to TTS_ENGINE for backwards compat)
    this.providerName = (
      process.env.TTS_PROVIDER ||
      process.env.TTS_ENGINE ||
      'polly'
    ).toLowerCase().trim();

    if (this.providerName === 'elevenlabs') {
      this.provider = this.elevenLabs;
      this.logger.log('🎙️ TTS provider: ElevenLabs');
    } else {
      this.provider = this.polly;
      this.logger.log('🎙️ TTS provider: AWS Polly');
    }
  }

  /**
   * Generate TTS audio. voiceId is optional — each provider uses its own
   * default from env if not passed.
   */
  synthesizeSpeech(text: string, voiceId?: string): Promise<Buffer> {
    return this.provider.synthesizeSpeech(text, voiceId);
  }

  getProviderName(): string {
    return this.providerName;
  }
}
