import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { PythonSocket } from '../python/python.socket';
import { PollyService } from '../tts/polly.service';

import {
  SessionCache,
  AudioDedupCache,
  SttRawCache,
  ExactResponseCache,
  TtsRelayCache,
} from '../cache';

/**
 * VoiceGateway – the front-facing Socket.IO gateway (port 3000).
 *
 * Frontend ←Socket.IO→ VoiceGateway ←Socket.IO→ Python AI (port 8080)
 *
 * NOTE: Python server.py uses a **single** Socket.IO connection from Nest.
 *       It identifies sessions via its own `sid`.  When Nest proxies a
 *       request on behalf of a frontend client, the Python side always
 *       replies to the **same** Nest socket.  Nest then routes the
 *       response back to the correct frontend client using a
 *       `frontendClientId` mapping.
 *
 * Python emits these events back to Nest:
 *   status, text_response, query_received,
 *   audio_start, audio_chunk, audio_end, audio_interrupted,
 *   transcription_start, transcription_complete,
 *   speculative_ready, response_interrupted,
 *   voice_changed, available_voices, error
 */
@WebSocketGateway(3000, {
  cors: { origin: '*' },
})
export class VoiceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  /**
   * We keep a mapping of frontendClientId → Python session data.
   * Since Nest has ONE socket to Python, we track which frontend
   * client sent the most recent message so we can route responses
   * back to them.  A production system would multiplex sessions.
   */
  private activeFrontendClient: string | null = null;

  /** Greeting sent to every new frontend client. Mirrors chatbot.start_session(). */
  private readonly GREETING =
    "Hello! Welcome to TechGropse, I'm Anup, your virtual assistant. What's your name?";

  constructor(
    private readonly python: PythonSocket,
    private readonly sessionCache: SessionCache,
    private readonly audioDedupCache: AudioDedupCache,
    private readonly sttRawCache: SttRawCache,
    private readonly exactResponseCache: ExactResponseCache,
    private readonly ttsRelayCache: TtsRelayCache,
    private readonly pollyService: PollyService,
  ) {}

  // =========================================================
  // Gateway lifecycle
  // =========================================================

  afterInit() {
    // Register ourselves to receive all events coming back from Python
    this.python.setMessageHandler(this.handlePythonMessage.bind(this));
    console.log('🎙️ VoiceGateway initialised – listening for Python events');
  }

  async handleConnection(client: Socket) {
    // Register this client as the active one
    this.activeFrontendClient = client.id;

    await this.sessionCache.set(client.id, {
      connectedAt: Date.now(),
    });
    console.log(`✅ Frontend client connected: ${client.id}`);

    // Tell the frontend it is connected so the UI unlocks
    client.emit('status', {
      message: 'Connected to TechGropse Server',
      type: 'success',
      session_id: client.id,
    });

    // Ask Python to create a fresh session for this user.
    // Python will emit back a text_response (initial_greeting) + audio,
    // which handlePythonMessage will forward to this client automatically.
    if (this.python.isConnected()) {
      this.python.sendNewSession();
    } else {
      // Python not yet available — fall back to a local greeting so
      // the chatbox still appears; Python will reply once it connects.
      client.emit('text_response', {
        response: this.GREETING,
        message: this.GREETING,
        type: 'initial_greeting',
        show_chatbox: true,
        current_field: 'name',
      });
    }
  }

  async handleDisconnect(client: Socket) {
    if (this.activeFrontendClient === client.id) {
      // Fall back to any remaining connected client, or null
      const remaining = [...this.server.sockets.sockets.keys()].find(
        (id) => id !== client.id,
      );
      this.activeFrontendClient = remaining ?? null;
    }
    console.log(`❌ Frontend client disconnected: ${client.id}`);
  }

  // =========================================================
  // FE → Nest  (frontend events)
  // =========================================================

  /**
   * Frontend sends text input.
   * We forward it to Python as a `text_input` Socket.IO event.
   */
  @SubscribeMessage('text_input')
  async handleTextInput(client: Socket, payload: { text: string }) {
    const { text } = payload;
    console.log(`💬 [${client.id}] text_input: "${text}"`);

    // Track which frontend client should receive the response
    this.activeFrontendClient = client.id;

    // Store query for caching
    const sessionData = (await this.sessionCache.get(client.id)) || {};
    sessionData.lastQuery = text;
    await this.sessionCache.set(client.id, sessionData);

    // Check exact-response cache
    const cached = await this.exactResponseCache.get('en', text);
    if (cached) {
      console.log('✅ Cache hit – returning cached response');
      const responseText = typeof cached === 'string' ? cached : cached.text || cached.response;

      client.emit('text_response', {
        response: responseText,
        message: responseText,
        type: 'cached',
      });

      client.emit('stream_complete', {
        fullResponse: responseText,
        metadata: { cached: true },
      });

      // Generate Polly audio for cached response
      await this.emitPollyAudio(client, responseText);
      return;
    }

    // Check Python is connected
    if (!this.python.isConnected()) {
      client.emit('error', { message: 'AI service not available. Retrying…' });
      return;
    }

    // Forward to Python AI
    this.python.sendTextQuery(client.id, text);
  }

  /**
   * Frontend sends text that should get ONLY a text reply (no audio).
   */
  @SubscribeMessage('text_only_input')
  async handleTextOnlyInput(client: Socket, payload: { text: string }) {
    const { text } = payload;
    console.log(`💬 [${client.id}] text_only_input: "${text}"`);

    this.activeFrontendClient = client.id;

    if (!this.python.isConnected()) {
      client.emit('error', { message: 'AI service not available' });
      return;
    }

    this.python.sendTextOnlyQuery(client.id, text);
  }

  /**
   * Frontend sends a voice recording (base64 audio).
   */
  @SubscribeMessage('voice_input')
  async handleVoiceInput(
    client: Socket,
    payload: { audio: string; format?: string },
  ) {
    console.log(`🎤 [${client.id}] voice_input (${payload.audio?.length || 0} chars b64)`);

    this.activeFrontendClient = client.id;

    if (!this.python.isConnected()) {
      client.emit('error', { message: 'AI service not available' });
      return;
    }

    this.python.sendVoiceInput(
      client.id,
      payload.audio,
      payload.format || 'webm',
    );
  }

  /**
   * Frontend streams small PCM/Opus chunks (real-time mic).
   * Dedup before forwarding.
   */
  @SubscribeMessage('audio_chunk')
  async handleAudioChunk(
    client: Socket,
    payload: { chunkBase64: string },
  ) {
    const audioBuffer = Buffer.from(payload.chunkBase64, 'base64');
    const isDup = await this.audioDedupCache.isDuplicate(client.id, audioBuffer);
    if (isDup) return;

    this.activeFrontendClient = client.id;

    this.python.emit('audio_chunk', {
      sessionId: client.id,
      audio: payload.chunkBase64,
    });
  }

  /**
   * Frontend sends interim speech for speculative execution.
   */
  @SubscribeMessage('interim_speech')
  async handleInterimSpeech(client: Socket, payload: { text: string }) {
    this.activeFrontendClient = client.id;
    this.python.sendInterimSpeech(client.id, payload.text);
  }

  /**
   * Frontend requests a session (explicit).
   * Note: Python already creates a session on `connect`, so this is
   * just an acknowledgement to the frontend.
   */
  @SubscribeMessage('create_session')
  async handleCreateSession(client: Socket) {
    console.log(`🔧 [${client.id}] create_session`);

    this.activeFrontendClient = client.id;

    await this.sessionCache.set(client.id, {
      connectedAt: Date.now(),
    });

    client.emit('session_ready', {
      sessionId: client.id,
      pythonSessionId: this.python.pythonSessionId,
      status: 'ready',
    });
  }

  /**
   * Frontend wants to change TTS voice.
   */
  @SubscribeMessage('change_voice')
  async handleChangeVoice(client: Socket, payload: { voiceId: string }) {
    this.activeFrontendClient = client.id;
    this.python.sendChangeVoice(payload.voiceId);
  }

  /**
   * Frontend requests available voices.
   */
  @SubscribeMessage('get_voices')
  async handleGetVoices(client: Socket) {
    this.activeFrontendClient = client.id;
    this.python.sendGetVoices();
  }

  /**
   * Replay previously cached TTS audio.
   */
  @SubscribeMessage('repeat_last')
  async repeatLast(client: Socket, payload: { responseId: string }) {
    const audio = await this.ttsRelayCache.get(payload.responseId);
    if (audio) {
      client.emit('audio', { audio: audio.toString('base64') });
    }
  }

  // =========================================================
  // Python → Nest  (responses from Python AI)
  // =========================================================

  private async handlePythonMessage(msg: any) {
    const client = this.getActiveClient();

    switch (msg.type) {
      // ----- session / status -----
      case 'STATUS': {
        console.log(`📡 Python status: ${msg.message}`);
        if (client) {
          client.emit('status', msg);

          // If this is the initial connection status that includes session_id,
          // also forward session info
          if (msg.session_id) {
            client.emit('session_ready', {
              sessionId: client.id,
              pythonSessionId: msg.session_id,
              status: 'ready',
            });
          }
        }
        break;
      }

      // ----- text response (LLM result) -----
      case 'TEXT_RESPONSE': {
        const responseText = msg.response || msg.message || '';
        console.log(`📝 Python text_response: "${responseText.substring(0, 60)}…"`);

        if (client) {
          // Forward text to frontend
          client.emit('text_response', {
            response: responseText,
            message: responseText,
            type: msg.python_type || 'response',
            show_chatbox: msg.show_chatbox,
            current_field: msg.current_field,
            contact_form_state: msg.contact_form_state,
          });

          // Also emit stream_complete so frontend knows response is done
          client.emit('stream_complete', {
            fullResponse: responseText,
            metadata: { intent: msg.intent },
          });

          // Cache the response
          const sessionData = await this.sessionCache.get(client.id);
          if (sessionData?.lastQuery) {
            await this.exactResponseCache.set('en', sessionData.lastQuery, responseText);
          }
        }
        break;
      }

      // ----- query acknowledgement -----
      case 'QUERY_RECEIVED': {
        if (client) client.emit('query_received', msg);
        break;
      }

      // ----- audio streaming -----
      case 'AUDIO_START': {
        if (client) client.emit('audio_start', msg);
        break;
      }

      case 'AUDIO_CHUNK': {
        if (client) {
          client.emit('audio_chunk', {
            data: msg.data,
            chunk_id: msg.chunk_id,
            format: msg.format || 'mp3',
            cached: msg.cached,
          });
        }
        break;
      }

      case 'AUDIO_END': {
        if (client) client.emit('audio_end', msg);
        break;
      }

      case 'AUDIO_INTERRUPTED': {
        if (client) client.emit('audio_interrupted', msg);
        break;
      }

      // ----- speech-to-text -----
      case 'TRANSCRIPTION_START': {
        if (client) client.emit('transcription_start', msg);
        break;
      }

      case 'TRANSCRIPTION_COMPLETE': {
        if (client) client.emit('transcription_complete', msg);
        break;
      }

      // ----- speculative execution -----
      case 'SPECULATIVE_READY': {
        if (client) client.emit('speculative_ready', msg);
        break;
      }

      // ----- interruption -----
      case 'RESPONSE_INTERRUPTED': {
        if (client) client.emit('response_interrupted', msg);
        break;
      }

      // ----- voice management -----
      case 'VOICE_CHANGED': {
        if (client) client.emit('voice_changed', msg);
        break;
      }

      case 'AVAILABLE_VOICES': {
        if (client) client.emit('available_voices', msg);
        break;
      }

      // ----- errors -----
      case 'ERROR': {
        console.error('❌ Python error:', msg.message || msg.error);
        if (client) client.emit('error', { message: msg.message || msg.error });
        break;
      }

      default:
        console.warn(`⚠️ Unhandled Python event type: ${msg.type}`);
    }
  }

  // =========================================================
  // Helpers
  // =========================================================

  /**
   * Look up the frontend Socket for the currently active client.
   */
  private getActiveClient(): Socket | null {
    if (!this.activeFrontendClient) return null;
    return this.server.sockets.sockets.get(this.activeFrontendClient) ?? null;
  }

  /**
   * Generate Polly audio and emit it to a frontend client.
   */
  private async emitPollyAudio(client: Socket, text: string) {
    try {
      const audioBuffer = await this.pollyService.synthesizeSpeech(
        text,
        process.env.POLLY_VOICE_ID || 'Joey',
      );
      client.emit('tts_audio', {
        audio: audioBuffer.toString('base64'),
        format: 'mp3',
      });
    } catch (error: any) {
      console.error('[Polly] TTS error:', error.message);
    }
  }
}
