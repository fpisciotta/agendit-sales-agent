// src/app.module.ts — Módulo raíz

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentConfigModule } from './config/agent-config.module';
import { FollowupModule } from './followup/followup.module';
import { Derivacion } from './memory/entities/derivacion.entity';
import { LeadPublicidad } from './memory/entities/lead-publicidad.entity';
import { Mensaje } from './memory/entities/mensaje.entity';
import { Cliente } from './memory/entities/cliente.entity';
import { RecontactoProgramado } from './memory/entities/recontacto-programado.entity';
import { Recontacto } from './memory/entities/recontacto.entity';
import { WebhookModule } from './webhook/webhook.module';

const ENTIDADES = [Mensaje, Derivacion, LeadPublicidad, Recontacto, Cliente, RecontactoProgramado];

/**
 * SQLite, en desarrollo y en producción.
 *
 * `synchronize` queda activo: sin él, cada columna nueva exige una migración a
 * mano y el agente arranca roto. El riesgo real de synchronize es que puede
 * borrar datos al renombrar o cambiar el tipo de una columna — mientras solo
 * agregues campos es seguro, pero hacé backup del .db antes de un deploy que
 * toque el esquema.
 *
 * OJO CON EL HOSTING: SQLite guarda todo en un archivo, así que necesita disco
 * persistente. En plataformas con filesystem efímero (Railway, Heroku, Render
 * sin volumen) cada deploy borra la base y con ella el historial, las
 * derivaciones y los recontactos. Si vas a deployar ahí, montá un volumen y
 * apuntá SQLITE_PATH adentro.
 *
 * Si algún día pasás a Postgres, definí DATABASE_URL y esto lo toma solo.
 */
function opcionesDb() {
  const url = process.env.DATABASE_URL;

  if (url) {
    return {
      type: 'postgres' as const,
      url,
      entities: ENTIDADES,
      synchronize: process.env.NODE_ENV !== 'production',
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
    // El primero de la lista que exista gana. Se contemplan los tres nombres
    // que usamos: .env.local en desarrollo, .env.production en el servidor, y
    // .env como respaldo. Sin esto, un archivo con el nombre "equivocado" se
    // ignora en silencio y el agente arranca sin claves.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', `.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
    }),
    TypeOrmModule.forRoot(opcionesDb()),
    ScheduleModule.forRoot(),
    AgentConfigModule,
    WebhookModule,
    FollowupModule,
  ],
})
export class AppModule {}
