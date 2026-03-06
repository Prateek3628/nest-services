export interface TtsProvider {
  synthesizeSpeech(text: string, voiceId?: string): Promise<Buffer>;
}
