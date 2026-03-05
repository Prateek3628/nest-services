import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UserContactDocument = UserContact & Document;

@Schema({ collection: 'user_contacts', timestamps: true })
export class UserContact {
  /** The socket/session ID that links this contact to a conversation */
  @Prop({ required: true, index: true })
  sessionId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  phone: string;

  /** Availability submitted via calendar (if user requested team connect) */
  @Prop({ type: Object, default: null })
  availability: {
    date: string;
    time: string;
    timezone: string;
  } | null;
}

export const UserContactSchema = SchemaFactory.createForClass(UserContact);
