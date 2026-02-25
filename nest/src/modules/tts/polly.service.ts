import { Injectable, Logger } from '@nestjs/common';
import { PollyClient, SynthesizeSpeechCommand, VoiceId } from '@aws-sdk/client-polly';
import { Readable } from 'stream';

@Injectable()
export class PollyService {
  private readonly logger = new Logger(PollyService.name);
  private polly: PollyClient;

  constructor() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials not found in environment variables');
    }

    this.polly = new PollyClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
    this.logger.log('🔊 AWS Polly service initialized');
  }

  async synthesizeSpeech(text: string, voiceId: string = 'Joey'): Promise<Buffer> {
    try {
      const command = new SynthesizeSpeechCommand({
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: voiceId as VoiceId,
        Engine: 'neural',
        SampleRate: '24000',
        TextType: 'text',
      });

      const response = await this.polly.send(command);

      if (response.AudioStream) {
        const stream = response.AudioStream as Readable;
        const chunks: Buffer[] = [];

        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }

        const audioBuffer = Buffer.concat(chunks);
        this.logger.debug(`Generated audio: ${audioBuffer.length} bytes`);
        return audioBuffer;
      }

      throw new Error('No audio stream in response');
    } catch (error) {
      this.logger.error(`Polly TTS error: ${error.message}`);
      throw error;
    }
  }
}
