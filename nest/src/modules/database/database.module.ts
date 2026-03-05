import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  UserContact,
  UserContactSchema,
  ConversationSession,
  ConversationSessionSchema,
} from './schemas';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>('MONGODB_URI'),
      }),
      inject: [ConfigService],
    }),
    MongooseModule.forFeature([
      { name: UserContact.name, schema: UserContactSchema },
      { name: ConversationSession.name, schema: ConversationSessionSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
