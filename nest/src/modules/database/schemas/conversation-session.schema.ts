import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ConversationSessionDocument = ConversationSession & Document;

@Schema({ collection: 'sessions', timestamps: true })
export class ConversationSession {
  /** The socket/session ID that links to user_contacts */
  @Prop({ required: true, index: true, unique: true })
  sessionId: string;

  /** Reference to user's personal info (same sessionId in user_contacts) */
  @Prop({ type: String, default: null })
  userContactId: string | null;

  /** Full conversation history */
  @Prop({
    type: [
      {
        role: { type: String, enum: ['user', 'assistant'] },
        message: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  messages: Array<{
    role: 'user' | 'assistant';
    message: string;
    timestamp: Date;
  }>;

  /** Whether user info has been collected */
  @Prop({ default: false })
  userInfoCollected: boolean;

  /** Current conversation state from Python */
  @Prop({ default: 'active' })
  state: string;
}

export const ConversationSessionSchema =
  SchemaFactory.createForClass(ConversationSession);
