import Redis from 'ioredis';

export const redisProvider = {
  provide: 'REDIS',
  useFactory: () => {
    const client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      // Never throw – silently retry in background so the app stays up
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,   // drop commands when disconnected (no hang)
      lazyConnect: true,           // don't connect until first command
      retryStrategy: () => 5000,   // retry every 5s, never give up
    });

    // Suppress unhandled error events – cache is optional
    client.on('error', () => {});

    return client;
  },
};
