// src/main.ts — Arranque del servidor

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger:
      process.env.NODE_ENV === 'production'
        ? ['log', 'warn', 'error']
        : ['log', 'debug', 'warn', 'error'],
  });

  const puerto = Number(process.env.PORT ?? 8000);
  await app.listen(puerto, '0.0.0.0');

  // El proveedor de IA y su modelo los loguea AiModule al resolverse.
  logger.log(`Agendit Sales Agent escuchando en el puerto ${puerto}`);

  const proveedor = (process.env.AI_PROVIDER ?? 'gemini').toLowerCase();
  const claveFaltante =
    proveedor === 'claude' && !process.env.ANTHROPIC_API_KEY
      ? 'ANTHROPIC_API_KEY'
      : proveedor === 'gemini' && !process.env.GEMINI_API_KEY
        ? 'GEMINI_API_KEY'
        : null;

  if (claveFaltante) {
    logger.warn(`${claveFaltante} no está configurada — el agente no va a poder responder`);
  }
}

void bootstrap();
