// src/main.ts — Arranque del servidor

// TODO lo que se guarda en la base va en UTC, sin importar dónde corra el
// proceso. Esto tiene que ejecutarse ANTES de importar cualquier módulo que
// cree fechas, por eso está arriba de los imports y no dentro de bootstrap().
// La hora de Paraguay se aplica solo en los bordes (ver src/common/tiempo.ts).
process.env.TZ = 'UTC';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { TZ_NEGOCIO, formatearNegocio } from './common/tiempo';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    // Necesario para verificar la firma de Meta: hay que hashear el cuerpo
    // exacto que llegó, no el JSON re-serializado (ver FirmaMetaGuard).
    rawBody: true,
    logger:
      process.env.NODE_ENV === 'production'
        ? ['log', 'warn', 'error']
        : ['log', 'debug', 'warn', 'error'],
  });

  const puerto = Number(process.env.PORT ?? 8000);
  await app.listen(puerto, '0.0.0.0');

  // El proveedor de IA y su modelo los loguea AiModule al resolverse.
  logger.log(`Agendit Sales Agent escuchando en el puerto ${puerto}`);
  logger.log(
    `Base en UTC · zona del negocio: ${TZ_NEGOCIO} (ahora son las ${formatearNegocio(new Date())})`,
  );

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
