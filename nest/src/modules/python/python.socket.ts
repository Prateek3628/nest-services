import { io, Socket } from 'socket.io-client';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

/**
 * Callback signature for handling messages from the Python AI service.
 * Messages always have a `type` field identifying the event kind,
 * plus arbitrary payload fields.
 */
export type PythonMessageHandler = (msg: any) => Promise<void>;

/**
 * PythonSocket – NestJS-managed Socket.IO client that keeps a single
 * persistent connection to the Python AI backend (server.py).
 *
 * Architecture:
 *   Frontend ←Socket.IO→ Nest VoiceGateway ←Socket.IO→ Python server.py
 *
 * Python server.py uses `python-socketio` with aiohttp.
 * It exposes standard Socket.IO events:
 *   - connect / disconnect (lifecycle)
 *   - text_query        (text + audio response)
 *   - text_only_query   (text response only, no audio)
 *   - voice_input       (audio blob → STT → response)
 *   - interim_speech     (speculative processing)
 *   - change_voice      (change TTS voice)
 *   - get_voices        (list available voices)
 *
 * It emits back:
 *   - status, text_response, query_received
 *   - audio_start, audio_chunk, audio_end, audio_interrupted
 *   - transcription_start, transcription_complete
 *   - speculative_ready, response_interrupted
 *   - voice_changed, available_voices
 *   - error
 */
@Injectable()
export class PythonSocket implements OnModuleInit, OnModuleDestroy {
  private socket: Socket | null = null;
  private messageHandler: PythonMessageHandler | null = null;

  // =========================================================
  // Lifecycle
  // =========================================================

  onModuleInit() {
    this.connect();
  }

  onModuleDestroy() {
    this.disconnect();
  }

  /**
   * Register an external handler (typically VoiceGateway) that will
   * receive every incoming event from Python, normalised into
   * `{ type: string, ...payload }` objects.
   */
  setMessageHandler(handler: PythonMessageHandler) {
    this.messageHandler = handler;
  }

  // =========================================================
  // Connection
  // =========================================================

  private connect() {
    const url = process.env.PYTHON_WS_URL || 'http://localhost:8080';
    console.log(`🔗 Connecting to Python AI service at ${url} (Socket.IO)...`);

    this.socket = io(url, {
      transports: ['websocket'],  // skip HTTP long-polling
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    // ----- connection lifecycle -----
    this.socket.on('connect', () => {
      console.log(`✅ Connected to Python AI service (id=${this.socket!.id})`);
    });

    this.socket.on('disconnect', (reason) => {
      console.warn(`⚠️ Python Socket.IO disconnected: ${reason}`);
    });

    this.socket.on('connect_error', (err) => {
      console.error(`❌ Python Socket.IO connect error: ${err.message}`);
    });

    // ----- events emitted by Python server.py -----

    // Session / status
    this.socket.on('status', (data) =>
      this.dispatch({ ...data, type: 'STATUS' }),
    );

    // Text response (LLM result)
    // Python sends its own `type` field (e.g. 'response', 'initial_greeting', 'text_only').
    // We preserve it as `python_type` so the gateway can forward it, while `type` becomes
    // the Nest-internal routing sentinel 'TEXT_RESPONSE'.
    this.socket.on('text_response', (data) => {
      const { type: python_type, ...rest } = data;
      this.dispatch({ ...rest, python_type, type: 'TEXT_RESPONSE' });
    });

    // Query acknowledgement
    this.socket.on('query_received', (data) =>
      this.dispatch({ ...data, type: 'QUERY_RECEIVED' }),
    );

    // Audio streaming events
    this.socket.on('audio_start', (data) =>
      this.dispatch({ ...data, type: 'AUDIO_START' }),
    );

    this.socket.on('audio_chunk', (data) =>
      this.dispatch({ ...data, type: 'AUDIO_CHUNK' }),
    );

    this.socket.on('audio_end', (data) =>
      this.dispatch({ ...data, type: 'AUDIO_END' }),
    );

    this.socket.on('audio_interrupted', (data) =>
      this.dispatch({ ...data, type: 'AUDIO_INTERRUPTED' }),
    );

    // Speech-to-text events
    this.socket.on('transcription_start', (data) =>
      this.dispatch({ ...data, type: 'TRANSCRIPTION_START' }),
    );

    this.socket.on('transcription_complete', (data) =>
      this.dispatch({ ...data, type: 'TRANSCRIPTION_COMPLETE' }),
    );

    // Speculative execution
    this.socket.on('speculative_ready', (data) =>
      this.dispatch({ ...data, type: 'SPECULATIVE_READY' }),
    );

    // Interruption
    this.socket.on('response_interrupted', (data) =>
      this.dispatch({ ...data, type: 'RESPONSE_INTERRUPTED' }),
    );

    // Voice management
    this.socket.on('voice_changed', (data) =>
      this.dispatch({ ...data, type: 'VOICE_CHANGED' }),
    );

    this.socket.on('available_voices', (data) =>
      this.dispatch({ ...data, type: 'AVAILABLE_VOICES' }),
    );

    // Errors
    this.socket.on('error', (data) =>
      this.dispatch({ ...data, type: 'ERROR' }),
    );

    this.socket.on('error_response', (data) =>
      this.dispatch({ ...data, type: 'ERROR' }),
    );
  }

  // =========================================================
  // Dispatch helpers
  // =========================================================

  private async dispatch(msg: any) {
    if (!this.messageHandler) return;
    try {
      await this.messageHandler(msg);
    } catch (err) {
      console.error('❌ Error in Python message handler:', err);
    }
  }

  // =========================================================
  // Public API – send events to Python
  // =========================================================

  /**
   * Ask Python to create a fresh session (called when a new frontend user connects).
   * Python will emit back a text_response with the greeting and start audio.
   */
  sendNewSession() {
    this.emit('new_session', {});
  }

  /**
   * Send a text query to Python for processing (with audio response).
   * Maps to Python's `@sio.event text_query`.
   */
  sendTextQuery(sessionId: string, text: string) {
    this.emit('text_query', { text, message: text });
  }

  /**
   * Send a text-only query (no audio response).
   * Maps to Python's `@sio.event text_only_query`.
   */
  sendTextOnlyQuery(sessionId: string, text: string) {
    this.emit('text_only_query', { text, message: text });
  }

  /**
   * Send voice input (base64 audio) for STT + processing.
   * Maps to Python's `@sio.event voice_input`.
   */
  sendVoiceInput(sessionId: string, audioBase64: string, format = 'webm') {
    this.emit('voice_input', { audio: audioBase64, format });
  }

  /**
   * Send interim speech for speculative execution.
   * Maps to Python's `@sio.event interim_speech`.
   */
  sendInterimSpeech(sessionId: string, text: string) {
    this.emit('interim_speech', { text });
  }

  /**
   * Request voice change.
   * Maps to Python's `@sio.event change_voice`.
   */
  sendChangeVoice(voiceId: string) {
    this.emit('change_voice', { voice_id: voiceId });
  }

  /**
   * Request available voices.
   * Maps to Python's `@sio.event get_voices`.
   */
  sendGetVoices() {
    this.emit('get_voices', {});
  }

  /**
   * Generic emit – sends a Socket.IO event to Python.
   */
  emit(event: string, data: any) {
    if (!this.socket?.connected) {
      console.error(`❌ Cannot emit '${event}' – not connected to Python`);
      return;
    }
    this.socket.emit(event, data);
  }

  // =========================================================
  // State
  // =========================================================

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** The Socket.IO id assigned by the Python server (acts as session id) */
  get pythonSessionId(): string | undefined {
    return this.socket?.id;
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}
