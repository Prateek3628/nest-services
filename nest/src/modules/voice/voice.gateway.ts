import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { PythonSocket } from '../python/python.socket';
import { TtsService } from '../tts/tts.service';

import {
  SessionCache,
  AudioDedupCache,
  SttRawCache,
  ExactResponseCache,
  TtsRelayCache,
} from '../cache';

import {
  UserContact,
  ConversationSession,
} from '../database/schemas';
import type {
  UserContactDocument,
  ConversationSessionDocument,
} from '../database/schemas';

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
@WebSocketGateway({
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

  /** Maps socket client.id → stable sessionId (UUID from frontend) */
  private clientToSession: Map<string, string> = new Map();

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
    private readonly ttsService: TtsService,
    @InjectModel(UserContact.name)
    private readonly userContactModel: Model<UserContactDocument>,
    @InjectModel(ConversationSession.name)
    private readonly conversationModel: Model<ConversationSessionDocument>,
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

    // Tell the frontend it is connected so the UI unlocks.
    // Do NOT start a Python session or send a greeting yet —
    // wait until the user submits the info form (register_user)
    // or an existing session is verified (check_session).
    client.emit('status', {
      message: 'Connected to TechGropse Server',
      type: 'success',
      session_id: client.id,
    });
  }

  async handleDisconnect(client: Socket) {
    if (this.activeFrontendClient === client.id) {
      // Fall back to any remaining connected client, or null
      const remaining = [...this.server.sockets.sockets.keys()].find(
        (id) => id !== client.id,
      );
      this.activeFrontendClient = remaining ?? null;
    }
    this.clientToSession.delete(client.id);
    console.log(`❌ Frontend client disconnected: ${client.id}`);
  }

  // =========================================================
  // FE → Nest  (frontend events)
  // =========================================================

  /**
   * Frontend sends text input.
   * We forward it to Python as a `text_query` Socket.IO event.
   */
  @SubscribeMessage('text_query')
  async handleTextInput(client: Socket, payload: { text: string }) {
    const { text } = payload;
    const sid = this.clientToSession.get(client.id) || client.id;
    console.log(`💬 [${client.id}] text_query: "${text}" (session: ${sid})`);

    // Track which frontend client should receive the response
    this.activeFrontendClient = client.id;

    // Store user message in MongoDB conversation
    await this.appendMessage(sid, 'user', text);

    // Store query for caching
    const sessionData = (await this.sessionCache.get(sid)) || {};
    sessionData.lastQuery = text;
    await this.sessionCache.set(sid, sessionData);

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
  // FE → Nest  (user registration & availability)
  // =========================================================

  /**
   * Frontend registers a new user (personal info form).
   * Saves to MongoDB `user_contacts` and links to the conversation session.
   */
  @SubscribeMessage('register_user')
  async handleRegisterUser(
    client: Socket,
    payload: { name: string; email: string; phone: string; sessionId: string },
  ) {
    const sid = payload.sessionId || client.id;
    console.log(`📋 [${client.id}] register_user: name="${payload.name}" email="${payload.email}" phone="${payload.phone}" sid="${sid}"`);

    try {
      // Step 1: Upsert user contact
      console.log(`💾 [register_user] Step 1: upserting user_contacts for sid=${sid}`);
      const contact = await this.userContactModel.findOneAndUpdate(
        { sessionId: sid },
        {
          sessionId: sid,
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
        },
        { upsert: true, returnDocument: 'after' },
      );
      console.log(`💾 [register_user] Step 1 done: contact._id=${contact?._id}`);

      // Step 2: Upsert conversation session and link it
      console.log(`💾 [register_user] Step 2: upserting sessions for sid=${sid}`);
      await this.conversationModel.findOneAndUpdate(
        { sessionId: sid },
        {
          sessionId: sid,
          userContactId: contact._id?.toString() ?? null,
          userInfoCollected: true,
        },
        { upsert: true, returnDocument: 'after' },
      );
      console.log(`💾 [register_user] Step 2 done`);

      // Step 3: Store in Redis session cache too
      console.log(`💾 [register_user] Step 3: writing Redis session cache`);
      const sessionData = (await this.sessionCache.get(sid)) || {};
      sessionData.userInfo = {
        name: payload.name,
        email: payload.email,
        phone: payload.phone,
      };
      sessionData.userInfoCollected = true;
      await this.sessionCache.set(sid, sessionData);
      console.log(`💾 [register_user] Step 3 done`);

      // Map this socket to the stable session ID
      this.clientToSession.set(client.id, sid);

      client.emit('user_registered', {
        success: true,
        sessionId: sid,
        message: 'User info saved successfully',
      });

      console.log(`✅ User registered and linked to session: ${sid}`);

      // NOW start the Python session (greeting happens here, not on connect)
      if (this.python.isConnected()) {
        this.python.sendNewSession();
      } else {
        client.emit('text_response', {
          response: this.GREETING,
          message: this.GREETING,
          type: 'initial_greeting',
          show_chatbox: true,
          current_field: 'name',
        });
      }
    } catch (error: any) {
      console.error('❌ Error registering user:', error.message, error.stack);
      client.emit('user_registered', {
        success: false,
        message: 'Failed to save user info',
        error: error.message,
      });
    }
  }

  /**
   * Frontend checks if a session already exists (on reconnect/refresh).
   */
  @SubscribeMessage('check_session')
  async handleCheckSession(
    client: Socket,
    payload: { sessionId: string },
  ) {
    const sid = payload.sessionId;
    console.log(`🔍 [${client.id}] check_session: ${sid}`);

    try {
      // Check Redis first (fast)
      let sessionData = await this.sessionCache.get(sid);

      if (sessionData?.userInfoCollected) {
        this.clientToSession.set(client.id, sid);
        client.emit('session_check_result', {
          exists: true,
          sessionId: sid,
          userInfo: sessionData.userInfo,
        });
        // Start Python session for returning user
        if (this.python.isConnected()) this.python.sendNewSession();
        return;
      }

      // Fallback: check MongoDB
      const contact = await this.userContactModel.findOne({ sessionId: sid });
      if (contact) {
        // Re-hydrate Redis cache
        const data = (await this.sessionCache.get(sid)) || {};
        data.userInfo = {
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
        };
        data.userInfoCollected = true;
        await this.sessionCache.set(sid, data);

        this.clientToSession.set(client.id, sid);
        client.emit('session_check_result', {
          exists: true,
          sessionId: sid,
          userInfo: data.userInfo,
        });
        // Start Python session for returning user
        if (this.python.isConnected()) this.python.sendNewSession();
        return;
      }

      client.emit('session_check_result', { exists: false });
    } catch (error: any) {
      console.error('❌ Error checking session:', error.message, error.stack);
      client.emit('session_check_result', { exists: false });
    }
  }

  /**
   * Frontend submits availability (date/time/timezone from calendar).
   * Save to MongoDB and forward to Python.
   */
  @SubscribeMessage('submit_availability')
  async handleSubmitAvailability(
    client: Socket,
    payload: {
      sessionId: string;
      date: string;
      time: string;
      timezone: string;
    },
  ) {
    const sid = payload.sessionId || client.id;
    console.log(`📅 [${client.id}] submit_availability: ${payload.date} ${payload.time} ${payload.timezone}`);

    this.activeFrontendClient = client.id;

    try {
      // Save availability to user_contacts
      await this.userContactModel.findOneAndUpdate(
        { sessionId: sid },
        {
          availability: {
            date: payload.date,
            time: payload.time,
            timezone: payload.timezone,
          },
        },
      );

      // Forward the formatted availability to Python as a text_query
      const availText = `My availability is ${payload.date} at ${payload.time} (${payload.timezone})`;
      this.python.sendTextQuery(client.id, availText);

      // Also log in conversation
      await this.appendMessage(sid, 'user', availText);

      client.emit('availability_saved', { success: true });
      console.log(`✅ Availability saved for session: ${sid}`);
    } catch (error: any) {
      console.error('❌ Error saving availability:', error.message);
      client.emit('availability_saved', { success: false });
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
          // Detect calendar trigger: Python wants to collect datetime
          const isCalendarTrigger =
            msg.contact_form_state === 'collecting_datetime' ||
            msg.current_field === 'datetime';

          // Forward text to frontend
          client.emit('text_response', {
            response: responseText,
            message: responseText,
            type: msg.python_type || 'response',
            show_chatbox: msg.show_chatbox,
            current_field: msg.current_field,
            contact_form_state: msg.contact_form_state,
          });

          // If Python wants datetime, tell frontend to show the calendar
          if (isCalendarTrigger) {
            console.log('📅 TRIGGER_CONTACT_FORM → sending show_calendar to frontend');
            client.emit('show_calendar', {
              message: responseText,
            });
          }

          // Also emit stream_complete so frontend knows response is done
          client.emit('stream_complete', {
            fullResponse: responseText,
            metadata: { intent: msg.intent },
          });

          // Store assistant message in MongoDB conversation
          const sid = this.clientToSession.get(client.id) || client.id;
          await this.appendMessage(sid, 'assistant', responseText);

          // Cache the response
          const sessionData = await this.sessionCache.get(sid);
          if (sessionData?.lastQuery) {
            await this.exactResponseCache.set('en', sessionData.lastQuery, responseText);
          }

          // Generate Polly TTS audio and send to frontend
          await this.emitPollyAudio(client, responseText);
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
      const voiceId =
        process.env.TTS_PROVIDER?.toLowerCase() === 'elevenlabs'
          ? process.env.ELEVEN_LABS_VOICE_ID
          : process.env.POLLY_VOICE_ID || 'Joey';

      const audioBuffer = await this.ttsService.synthesizeSpeech(text, voiceId);
      client.emit('tts_audio', {
        audio: audioBuffer.toString('base64'),
        format: 'mp3',
      });
    } catch (error: any) {
      console.error('[TTS] audio generation error:', error.message);
    }
  }

  /**
   * Append a message to the MongoDB conversation session.
   */
  private async appendMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    message: string,
  ) {
    try {
      // Only update if session doc already exists (created during register_user)
      await this.conversationModel.updateOne(
        { sessionId },
        {
          $push: {
            messages: { role, message, timestamp: new Date() },
          },
        },
      );
    } catch (error: any) {
      console.error('❌ Error appending message:', error.message);
    }
  }
}
