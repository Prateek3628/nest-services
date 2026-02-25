import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS for frontend connections
  app.enableCors({
    origin: '*',
    credentials: true,
  });
  
  await app.listen(process.env.PORT ?? 5001);
  console.log(`🚀 Nest Gateway listening on http://localhost:${process.env.PORT ?? 3000}`);
}
bootstrap();
