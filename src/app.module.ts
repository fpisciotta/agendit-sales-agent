// src/app.module.ts — Módulo raíz

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentConfigModule } from './config/agent-config.module';
import { Derivacion } from './memory/entities/derivacion.entity';
import { LeadPublicidad } from './memory/entities/lead-publicidad.entity';
import { Mensaje } from './memory/entities/mensaje.entity';
import { WebhookModule } from './webhook/webhook.module';

const ENTIDADES = [Mensaje, Derivacion, LeadPublicidad];

/**
 * SQLite para desarrollo, PostgreSQL en producción (Railway inyecta
 * DATABASE_URL). `synchronize` solo en desarrollo: en producción crea y
 * modifica tablas sin control, que es justo lo que no querés en una base
 * con datos de clientes.
 */
function opcionesDb() {
  const url = process.env.DATABASE_URL;
  const esProduccion = process.env.NODE_ENV === 'production';

  if (url) {
    return {
      type: 'postgres' as const,
      url,
      entities: ENTIDADES,
      synchronize: !esProduccion,
      ssl: esProduccion ? { rejectUnauthorized: false } : false,
    };
  }

  return {
    type: 'better-sqlite3' as const,
    database: process.env.SQLITE_PATH ?? './agendit-sales-agent.db',
    entities: ENTIDADES,
    synchronize: true,
  };
}

@Module({
  imports: [
    // El primero de la lista gana. .env.local es el que usamos; .env queda
    // como respaldo para entornos donde se monte con ese nombre.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    TypeOrmModule.forRoot(opcionesDb()),
    AgentConfigModule,
    WebhookModule,
  ],
})
export class AppModule {}
