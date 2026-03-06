import { Injectable, Logger } from '@nestjs/common';
import { TtsProvider } from './tts.interface';

@Injectable()
export class ElevenLabsService implements TtsProvider {
  private readonly logger = new Logger(ElevenLabsService.name);

  private readonly apiKey: string;
  private readonly defaultVoiceId: string;
  private readonly modelId: string;
  private readonly outputFormat: string;

  constructor() {
    this.apiKey = process.env.ELEVEN_LABS_API_KEY ?? '';
    this.defaultVoiceId = process.env.ELEVEN_LABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';
    this.modelId = process.env.ELEVEN_LABS_MODEL_ID ?? 'eleven_turbo_v2';
    this.outputFormat = process.env.ELEVEN_LABS_OUTPUT_FORMAT ?? 'mp3_22050_32';

    if (!this.apiKey) {
      this.logger.error('❌ ELEVEN_LABS_API_KEY is not set!');
    } else {
      this.logger.log('🔊 ElevenLabs TTS service initialized');
    }
  }

  async synthesizeSpeech(text: string, voiceId?: string): Promise<Buffer> {
    const voice = voiceId || this.defaultVoiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=${this.outputFormat}`;

    this.logger.debug(`ElevenLabs TTS → voice=${voice} model=${this.modelId} chars=${text.length}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: this.modelId,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      this.logger.error(`ElevenLabs API error ${response.status}: ${errText}`);
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${errText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);
    this.logger.debug(`ElevenLabs audio generated: ${audioBuffer.length} bytes`);
    return audioBuffer;
  }
}
