import { Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  UserContact,
  UserContactSchema,
  ConversationSession,
  ConversationSessionSchema,
} from './schemas';

const dbLogger = new Logger('DatabaseModule');

@Module({
  imports: [
    MongooseModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('MONGODB_URI');
        if (!uri) {
          dbLogger.error('❌ MONGODB_URI is undefined! Check your ecosystem.config.js or .env file.');
        } else {
          const masked = uri.replace(/:\/\/([^:]+):([^@]+)@/, '://<user>:<pass>@');
          dbLogger.log(`🔗 Connecting to MongoDB: ${masked}`);
        }
        return {
          uri,
          connectionFactory: (connection: any) => {
            connection.on('connected', () => dbLogger.log('✅ MongoDB connected successfully'));
            connection.on('error', (err: any) => dbLogger.error(`❌ MongoDB connection error: ${err.message}`));
            connection.on('disconnected', () => dbLogger.warn('⚠️ MongoDB disconnected'));
            return connection;
          },
        };
      },
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
