// src/memory/memory.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Derivacion } from './entities/derivacion.entity';
import { LeadPublicidad } from './entities/lead-publicidad.entity';
import { Mensaje } from './entities/mensaje.entity';
import { Cliente } from './entities/cliente.entity';
import { RecontactoProgramado } from './entities/recontacto-programado.entity';
import { Recontacto } from './entities/recontacto.entity';
import { MemoryService } from './memory.service';

@Module({
  imports: [TypeOrmModule.forFeature([Mensaje, Derivacion, LeadPublicidad, Recontacto, Cliente, RecontactoProgramado])],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
